import type {
  CashflowActivity,
  CashflowActivityLeg,
  CashflowCategory,
  CashflowChainFees,
  CashflowCounterparty,
  CashflowMonth,
  CashflowPosition,
  CashflowReport,
  CashflowTxType,
  CashflowWalletCoverage,
} from '@nexus/types';
import type { PriceRef } from './base-assets';

/**
 * Pure cash-flow engine: turns raw per-wallet asset movements + gas fees into
 * a Mint-style report. No I/O — fetchers normalize provider data into
 * `LedgerMovement`/`LedgerFee`, and prices come in through `UsdPricer`.
 *
 * The user's linked wallets are treated as one entity: movements between them
 * are excluded from in/out and reported separately as own-wallet transfers.
 *
 * Classification is per transaction, from the user's perspective:
 *  - "priced" legs (native coin, wrapped native, stablecoins) are money;
 *  - "unpriced" legs (NFTs, other tokens) are things bought/sold with money.
 * Money out + things in = purchase/mint, things out + money in = sale,
 * things both ways = swap (cost basis carries over), money only = transfer.
 * Cost basis is tracked per NFT token id, and average-cost for fungibles.
 */

export type AssetKind = 'native' | 'fungible' | 'nft';

export interface LedgerAsset {
  /** Unique per chain+contract (NFTs may be keyed by collection instead of mint). */
  key: string;
  chain: string;
  kind: AssetKind;
  contract: string;
  name: string;
  symbol: string | null;
  /** Set for assets we treat as money; null for everything else. */
  price: PriceRef | null;
}

export interface LedgerMovement {
  chain: string;
  txHash: string;
  timestamp: Date;
  /** The linked wallet this movement belongs to. */
  wallet: string;
  direction: 'in' | 'out';
  asset: LedgerAsset;
  tokenId: string | null;
  /** Units (decimal-adjusted); NFTs are 1 unless ERC-1155. */
  amount: number;
  /** The other side of the transfer; '' for the zero address (mint/burn). */
  counterparty: string;
}

export interface LedgerFee {
  chain: string;
  txHash: string;
  wallet: string;
  timestamp: Date;
  feeNative: number;
  /** Native symbol the fee was paid in (ETH, POL, APE, SOL). */
  symbol: string;
}

export interface UsdPricer {
  /** USD value of one unit on the given UTC day ('YYYY-MM-DD'), or null if unknown. */
  usdPerUnit(ref: PriceRef, day: string): number | null;
}

export interface BuildReportInput {
  movements: LedgerMovement[];
  fees: LedgerFee[];
  wallets: Array<{ chain: string; address: string }>;
  pricer: UsdPricer;
  coverage: CashflowWalletCoverage[];
  notes: string[];
  now: Date;
  activityLimit?: number;
}

const EPSILON = 1e-12;

/** Chain-family-aware identity for an address (EVM addresses are shared across EVM chains). */
export function addressIdentity(chain: string, address: string): string {
  return chain === 'solana' ? `solana:${address}` : `evm:${address.toLowerCase()}`;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (d: Date) => d.toISOString().slice(0, 7);

interface Lot {
  qty: number;
  cost: number;
}

class Position {
  readonly lots = new Map<string, Lot>();
  buyCount = 0;
  sellCount = 0;
  qtyBought = 0;
  qtySold = 0;
  spentUsd = 0;
  proceedsUsd = 0;
  realizedPnlUsd = 0;
  qtySoldWithoutBasis = 0;
  firstAt: Date;
  lastAt: Date;

  constructor(readonly asset: LedgerAsset, at: Date) {
    this.firstAt = at;
    this.lastAt = at;
  }

  touch(at: Date) {
    if (at < this.firstAt) this.firstAt = at;
    if (at > this.lastAt) this.lastAt = at;
  }

  lotKey(tokenId: string | null): string {
    return this.asset.kind === 'nft' && tokenId !== null ? tokenId : '*';
  }

  acquire(qty: number, costUsd: number, tokenId: string | null) {
    const key = this.lotKey(tokenId);
    const lot = this.lots.get(key) ?? { qty: 0, cost: 0 };
    lot.qty += qty;
    lot.cost += costUsd;
    this.lots.set(key, lot);
  }

  /** Remove `qty` units; returns the cost basis removed and how many units had no known basis. */
  dispose(qty: number, tokenId: string | null): { basis: number; missing: number } {
    const key = this.lotKey(tokenId);
    const lot = this.lots.get(key);
    if (!lot || lot.qty <= EPSILON) return { basis: 0, missing: qty };
    const take = Math.min(qty, lot.qty);
    const basis = lot.qty > 0 ? (lot.cost * take) / lot.qty : 0;
    lot.qty -= take;
    lot.cost -= basis;
    if (lot.qty <= EPSILON) this.lots.delete(key);
    const missing = qty - take;
    return { basis, missing: missing > EPSILON ? missing : 0 };
  }

  get qtyHeld(): number {
    let q = 0;
    for (const lot of this.lots.values()) q += lot.qty;
    return q;
  }

  get openCost(): number {
    let c = 0;
    for (const lot of this.lots.values()) c += lot.cost;
    return c;
  }
}

interface PricedLeg {
  movement: LedgerMovement;
  usd: number | null;
}

export function buildCashflowReport(input: BuildReportInput): CashflowReport {
  const { pricer } = input;
  const own = new Set(input.wallets.map((w) => addressIdentity(w.chain, w.address)));
  const isOwn = (chain: string, addr: string) => addr !== '' && own.has(addressIdentity(chain, addr));

  // ── Group movements and fees by transaction ──
  const groups = new Map<string, TxGroup>();
  const groupFor = (chain: string, txHash: string, timestamp: Date, wallet: string) => {
    const key = `${chain}:${txHash}`;
    let g = groups.get(key);
    if (!g) {
      g = { chain, txHash, timestamp, wallet, movements: [], fee: null };
      groups.set(key, g);
    }
    return g;
  };
  for (const m of input.movements) {
    if (!(m.amount > 0)) continue;
    groupFor(m.chain, m.txHash, m.timestamp, m.wallet).movements.push(m);
  }
  for (const f of input.fees) {
    const g = groupFor(f.chain, f.txHash, f.timestamp, f.wallet);
    // One sender per tx — the same fee can surface from two linked wallets' scans.
    if (!g.fee) g.fee = f;
  }

  const ordered = [...groups.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.txHash.localeCompare(b.txHash));

  // ── Pass 1: split each tx into own-wallet moves, money legs, and asset legs ──
  let unpricedMovements = 0;
  const priceLeg = (m: LedgerMovement): number | null => {
    if (!m.asset.price) return null;
    const rate = pricer.usdPerUnit(m.asset.price, dayKey(m.timestamp));
    if (rate === null) {
      unpricedMovements++;
      return null;
    }
    return rate * m.amount;
  };
  const analyses = new Map<TxGroup, TxAnalysis>();
  for (const g of ordered) analyses.set(g, analyze(g, isOwn, priceLeg, pricer));

  // ── Pass 2: pair cross-chain moves between the user's own wallets ──
  const bridgeRoles = matchBridges(ordered, analyses);

  // ── Accumulators ──
  const months = new Map<string, CashflowMonth>();
  const monthFor = (d: Date) => {
    const key = monthKey(d);
    let m = months.get(key);
    if (!m) {
      m = { month: key, inUsd: 0, outUsd: 0, feesUsd: 0, realizedPnlUsd: 0, byCategory: {} };
      months.set(key, m);
    }
    return m;
  };
  const outByCategory: Partial<Record<CashflowCategory, number>> = {};
  const inByCategory: Partial<Record<CashflowCategory, number>> = {};
  let totalIn = 0;
  let totalOut = 0;
  let totalFees = 0;
  let totalRealized = 0;

  const book = (d: Date, dir: 'in' | 'out', category: CashflowCategory, usd: number) => {
    if (!(usd > 0)) return;
    const m = monthFor(d);
    m.byCategory[category] = (m.byCategory[category] ?? 0) + usd;
    const bucket = dir === 'in' ? inByCategory : outByCategory;
    bucket[category] = (bucket[category] ?? 0) + usd;
    if (dir === 'in') {
      m.inUsd += usd;
      totalIn += usd;
    } else {
      m.outUsd += usd;
      totalOut += usd;
    }
  };
  const bookRealized = (d: Date, usd: number) => {
    monthFor(d).realizedPnlUsd += usd;
    totalRealized += usd;
  };

  const positions = new Map<string, Position>();
  const positionFor = (asset: LedgerAsset, at: Date) => {
    let p = positions.get(asset.key);
    if (!p) {
      p = new Position(asset, at);
      positions.set(asset.key, p);
    }
    p.touch(at);
    return p;
  };

  const counterparties = new Map<string, CashflowCounterparty>();
  const counterpartyFor = (chain: string, address: string, at: Date) => {
    const key = addressIdentity(chain, address) + `@${chain}`;
    let c = counterparties.get(key);
    if (!c) {
      c = { chain, address, sentUsd: 0, receivedUsd: 0, sentCount: 0, receivedCount: 0, lastAt: at.toISOString() };
      counterparties.set(key, c);
    }
    if (at.toISOString() > c.lastAt) c.lastAt = at.toISOString();
    return c;
  };

  const feesByChain = new Map<string, CashflowChainFees>();
  const ownTransfers = { count: 0, usd: 0 };
  const bridges = { count: 0, usd: 0, feesUsd: 0 };
  const activity: CashflowActivity[] = [];
  let txCount = 0;
  let firstAt: Date | null = null;
  let lastAt: Date | null = null;

  for (const g of ordered) {
    const at = g.timestamp;
    const bookTransfers = (legs: PricedLeg[], dir: 'in' | 'out') => {
      for (const l of legs) {
        const usd = l.usd ?? 0;
        book(at, dir, dir === 'in' ? 'transfer_in' : 'transfer_out', usd);
        const c = counterpartyFor(g.chain, l.movement.counterparty || 'unknown', at);
        if (dir === 'in') {
          c.receivedUsd += usd;
          c.receivedCount++;
        } else {
          c.sentUsd += usd;
          c.sentCount++;
        }
      }
    };

    // ── Fee ──
    let feeUsd = 0;
    if (g.fee && g.fee.feeNative > 0) {
      const rate = pricer.usdPerUnit({ kind: 'native', symbol: g.fee.symbol }, dayKey(at));
      if (rate === null) unpricedMovements++;
      feeUsd = (rate ?? 0) * g.fee.feeNative;
      const f = feesByChain.get(g.chain) ?? { chain: g.chain, symbol: g.fee.symbol, feesNative: 0, feesUsd: 0, txCount: 0 };
      f.feesNative += g.fee.feeNative;
      f.feesUsd += feeUsd;
      f.txCount++;
      feesByChain.set(g.chain, f);
      totalFees += feeUsd;
      const m = monthFor(at);
      m.feesUsd += feeUsd;
      book(at, 'out', 'gas_fees', feeUsd);
    }

    const a = analyses.get(g)!;
    const { external, hadOwnMove, ownMoveUsd, pricedIn, pricedOut, unIn, unOut, moneyIn, moneyOut } = a;
    const bridge = bridgeRoles.get(g);

    if (bridge) {
      // ── One side of a cross-chain move between the user's own wallets ──
      txCount++;
      if (!firstAt || at < firstAt) firstAt = at;
      if (!lastAt || at > lastAt) lastAt = at;
      const pair = bridge.pair;
      let bridgeFee = 0;
      if (bridge.side === 'out') {
        // Whatever didn't arrive is the bridge's fee — a real cost, like gas.
        bridgeFee = Math.max(0, bridge.self.usd - pair.usd);
        if (bridgeFee > 0) {
          totalFees += bridgeFee;
          monthFor(at).feesUsd += bridgeFee;
          book(at, 'out', 'gas_fees', bridgeFee);
        }
        bridges.count++;
        bridges.usd += bridge.self.usd;
        bridges.feesUsd += bridgeFee;
      }
      const legsSrc = bridge.self.legs;
      const phrase = assetPhrase(legsSrc.map((l) => l.movement));
      const label =
        bridge.side === 'out'
          ? `Bridged ${phrase} · ${chainName(g.chain)} → ${chainName(pair.group.chain)}`
          : `Bridge arrival: ${phrase} from ${chainName(pair.group.chain)}`;
      activity.push({
        chain: g.chain,
        txHash: g.txHash,
        timestamp: at.toISOString(),
        wallet: g.wallet,
        type: 'bridge',
        label,
        inUsd: 0,
        outUsd: feeUsd + bridgeFee,
        feeUsd: feeUsd + bridgeFee,
        realizedPnlUsd: null,
        counterparty: null,
        legs: legsSrc.map((l) => toLeg(l.movement, l.usd)),
      });
      continue;
    }

    if (external.length === 0 && !g.fee) {
      if (hadOwnMove) {
        ownTransfers.count++;
        ownTransfers.usd += ownMoveUsd;
      }
      continue;
    }

    txCount++;
    if (!firstAt || at < firstAt) firstAt = at;
    if (!lastAt || at > lastAt) lastAt = at;

    let type: CashflowTxType;
    let realized: number | null = null;
    let txIn = 0;
    let txOut = feeUsd;
    const legUsd = new Map<LedgerMovement, number>();
    let counterparty: string | null = null;

    if (unIn.length > 0 && unOut.length === 0) {
      // ── Acquisition: purchase, mint, or free receive ──
      const cost = Math.max(0, moneyOut - moneyIn);
      const share = cost / unIn.length;
      const allMint = unIn.every((m) => m.counterparty === '');
      for (const m of unIn) {
        const p = positionFor(m.asset, at);
        p.acquire(m.amount, share, m.tokenId);
        if (cost > 0) {
          p.buyCount++;
          p.qtyBought += m.amount;
          p.spentUsd += share;
          legUsd.set(m, share);
          const category: CashflowCategory =
            m.asset.kind === 'nft' ? (m.counterparty === '' ? 'nft_mint' : 'nft_purchase') : 'token_purchase';
          book(at, 'out', category, share);
        }
      }
      txOut += cost;
      if (cost > 0) {
        type = unIn.some((m) => m.asset.kind === 'nft') ? (allMint ? 'nft_mint' : 'nft_purchase') : 'token_purchase';
      } else {
        type = 'received_asset';
        counterparty = unIn[0].counterparty || null;
      }
      if (moneyIn > moneyOut) {
        // Rare: received both an asset and net money (e.g. a promo) — money counts as incoming.
        book(at, 'in', 'transfer_in', moneyIn - moneyOut);
        txIn += moneyIn - moneyOut;
      }
    } else if (unOut.length > 0 && unIn.length === 0) {
      const proceeds = moneyIn - moneyOut;
      if (proceeds > 0) {
        // ── Sale ──
        const share = proceeds / unOut.length;
        realized = 0;
        for (const m of unOut) {
          const p = positionFor(m.asset, at);
          const { basis, missing } = p.dispose(m.amount, m.tokenId);
          p.sellCount++;
          p.qtySold += m.amount;
          p.qtySoldWithoutBasis += missing;
          p.proceedsUsd += share;
          p.realizedPnlUsd += share - basis;
          realized += share - basis;
          legUsd.set(m, share);
          book(at, 'in', m.asset.kind === 'nft' ? 'nft_sale' : 'token_sale', share);
        }
        bookRealized(at, realized);
        txIn += proceeds;
        type = unOut.some((m) => m.asset.kind === 'nft') ? 'nft_sale' : 'token_sale';
      } else {
        // ── Gave an asset away (gift, move to an unlinked wallet, burn) ──
        for (const m of unOut) positionFor(m.asset, at).dispose(m.amount, m.tokenId);
        type = 'sent_asset';
        counterparty = unOut[0].counterparty || null;
        if (moneyOut > moneyIn) {
          bookTransfers(pricedOut, 'out');
          txOut += moneyOut - moneyIn;
        }
      }
    } else if (unIn.length > 0 && unOut.length > 0) {
      // ── Asset-for-asset swap: basis carries over, plus/minus any money leg ──
      let carried = 0;
      for (const m of unOut) carried += positionFor(m.asset, at).dispose(m.amount, m.tokenId).basis;
      const netMoney = moneyOut - moneyIn;
      if (netMoney < 0) {
        // Received money on top: realize it as a zero-basis sale.
        realized = -netMoney;
        bookRealized(at, realized);
        book(at, 'in', 'token_sale', -netMoney);
        txIn += -netMoney;
      } else if (netMoney > 0) {
        book(at, 'out', unIn[0].asset.kind === 'nft' ? 'nft_purchase' : 'token_purchase', netMoney);
        txOut += netMoney;
      }
      const basis = carried + Math.max(0, netMoney);
      const share = basis / unIn.length;
      for (const m of unIn) {
        positionFor(m.asset, at).acquire(m.amount, share, m.tokenId);
        legUsd.set(m, share);
      }
      type = 'swap';
    } else if (pricedIn.length > 0 && pricedOut.length > 0) {
      // Money-for-money (ETH→USDC, wrapping): a conversion, not spending.
      type = 'swap';
    } else if (pricedOut.length > 0) {
      bookTransfers(pricedOut, 'out');
      txOut += moneyOut;
      type = 'transfer_out';
      counterparty = pricedOut[0].movement.counterparty || null;
    } else if (pricedIn.length > 0) {
      bookTransfers(pricedIn, 'in');
      txIn += moneyIn;
      type = 'transfer_in';
      counterparty = pricedIn[0].movement.counterparty || null;
    } else {
      type = hadOwnMove ? 'own_wallet_transfer' : 'contract_interaction';
    }

    if (hadOwnMove) {
      ownTransfers.count++;
      ownTransfers.usd += ownMoveUsd;
    }

    if (external.length === 0 && type !== 'own_wallet_transfer' && type !== 'contract_interaction') continue;

    for (const l of [...pricedIn, ...pricedOut]) legUsd.set(l.movement, l.usd ?? 0);
    const legs: CashflowActivityLeg[] = [...pricedIn, ...pricedOut].map((l) => toLeg(l.movement, l.usd));
    for (const m of [...unIn, ...unOut]) legs.push(toLeg(m, legUsd.get(m) ?? null));

    activity.push({
      chain: g.chain,
      txHash: g.txHash,
      timestamp: at.toISOString(),
      wallet: g.wallet,
      type,
      label: describe(type, unIn, unOut, pricedIn, pricedOut),
      inUsd: txIn,
      outUsd: txOut,
      feeUsd,
      realizedPnlUsd: realized,
      counterparty,
      legs,
    });
  }

  // ── Positions → collections / tokens ──
  const collections: CashflowPosition[] = [];
  const tokens: CashflowPosition[] = [];
  for (const p of positions.values()) {
    const row: CashflowPosition = {
      key: p.asset.key,
      chain: p.asset.chain,
      kind: p.asset.kind === 'nft' ? 'nft' : 'fungible',
      contract: p.asset.contract,
      name: p.asset.name,
      symbol: p.asset.symbol,
      buyCount: p.buyCount,
      sellCount: p.sellCount,
      qtyBought: p.qtyBought,
      qtySold: p.qtySold,
      qtyHeld: p.qtyHeld,
      spentUsd: p.spentUsd,
      proceedsUsd: p.proceedsUsd,
      realizedPnlUsd: p.realizedPnlUsd,
      openCostBasisUsd: p.openCost,
      qtySoldWithoutBasis: p.qtySoldWithoutBasis,
      firstAt: p.firstAt.toISOString(),
      lastAt: p.lastAt.toISOString(),
    };
    (row.kind === 'nft' ? collections : tokens).push(row);
  }
  const byActivity = (a: CashflowPosition, b: CashflowPosition) =>
    b.spentUsd + b.proceedsUsd - (a.spentUsd + a.proceedsUsd) || b.lastAt.localeCompare(a.lastAt);
  collections.sort(byActivity);
  tokens.sort(byActivity);

  const openCostBasisUsd = [...collections, ...tokens].reduce((s, p) => s + p.openCostBasisUsd, 0);

  // ── Months: fill gaps so the chart has a continuous axis ──
  const monthRows: CashflowMonth[] = [];
  if (firstAt && lastAt) {
    const cursor = new Date(Date.UTC(firstAt.getUTCFullYear(), firstAt.getUTCMonth(), 1));
    const end = new Date(Date.UTC(lastAt.getUTCFullYear(), lastAt.getUTCMonth(), 1));
    while (cursor <= end) {
      const key = monthKey(cursor);
      monthRows.push(months.get(key) ?? { month: key, inUsd: 0, outUsd: 0, feesUsd: 0, realizedPnlUsd: 0, byCategory: {} });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  const limit = input.activityLimit ?? 1000;
  activity.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    generatedAt: input.now.toISOString(),
    wallets: input.wallets,
    firstActivityAt: firstAt?.toISOString() ?? null,
    lastActivityAt: lastAt?.toISOString() ?? null,
    totals: {
      inUsd: totalIn,
      outUsd: totalOut,
      netUsd: totalIn - totalOut,
      feesUsd: totalFees,
      realizedPnlUsd: totalRealized,
      openCostBasisUsd,
      txCount,
      unpricedMovements,
    },
    outByCategory,
    inByCategory,
    months: monthRows,
    collections,
    tokens,
    counterparties: [...counterparties.values()]
      .sort((a, b) => b.sentUsd + b.receivedUsd - (a.sentUsd + a.receivedUsd))
      .slice(0, 250),
    fees: [...feesByChain.values()].sort((a, b) => b.feesUsd - a.feesUsd),
    ownWalletTransfers: ownTransfers,
    bridges,
    activity: activity.slice(0, limit),
    coverage: input.coverage,
    notes: input.notes,
  };
}

interface TxGroup {
  chain: string;
  txHash: string;
  timestamp: Date;
  wallet: string;
  movements: LedgerMovement[];
  fee: LedgerFee | null;
}

interface TxAnalysis {
  /** Legs whose counterparty is not one of the user's wallets. */
  external: LedgerMovement[];
  hadOwnMove: boolean;
  /** Value moved between own wallets, counted once from the sending side. */
  ownMoveUsd: number;
  /** Money legs arriving from one of the user's own addresses with no sending leg here (bridge deposits). */
  ownArrivals: PricedLeg[];
  pricedIn: PricedLeg[];
  pricedOut: PricedLeg[];
  unIn: LedgerMovement[];
  unOut: LedgerMovement[];
  moneyIn: number;
  moneyOut: number;
}

function analyze(
  g: TxGroup,
  isOwn: (chain: string, addr: string) => boolean,
  priceLeg: (m: LedgerMovement) => number | null,
  pricer: UsdPricer,
): TxAnalysis {
  const external: LedgerMovement[] = [];
  const ownIn: LedgerMovement[] = [];
  let ownMoveUsd = 0;
  let hadOwnMove = false;
  for (const m of g.movements) {
    if (isOwn(m.chain, m.counterparty)) {
      hadOwnMove = true;
      if (m.direction === 'out') {
        ownMoveUsd += priceLegQuiet(pricer, m) ?? 0;
      } else {
        ownIn.push(m);
      }
    } else {
      external.push(m);
    }
  }
  // Own wallets pay gas for transfers they send, so an incoming leg "from" an
  // own address in a tx we paid no gas for was not sent on this chain: it's
  // money arriving from another chain (canonical-bridge deposit, or the same
  // address bridging L1→L2).
  const ownArrivals: PricedLeg[] = [];
  if (!g.fee) {
    for (const m of ownIn) {
      if (m.asset.price) ownArrivals.push({ movement: m, usd: priceLegQuiet(pricer, m) });
    }
  }

  // Net money legs per asset (e.g. pay 1 ETH, get 0.2 ETH refund).
  const pricedIn: PricedLeg[] = [];
  const pricedOut: PricedLeg[] = [];
  const unIn: LedgerMovement[] = [];
  const unOut: LedgerMovement[] = [];
  const netByAsset = new Map<string, { in: LedgerMovement[]; out: LedgerMovement[]; net: number }>();
  for (const m of external) {
    if (m.asset.price) {
      const e = netByAsset.get(m.asset.key) ?? { in: [], out: [], net: 0 };
      e[m.direction].push(m);
      e.net += m.direction === 'in' ? m.amount : -m.amount;
      netByAsset.set(m.asset.key, e);
    } else {
      (m.direction === 'in' ? unIn : unOut).push(m);
    }
  }
  for (const e of netByAsset.values()) {
    if (Math.abs(e.net) <= EPSILON) continue;
    const dominant = e.net > 0 ? e.in : e.out;
    const gross = dominant.reduce((sum, m) => sum + m.amount, 0);
    const scale = gross > 0 ? Math.abs(e.net) / gross : 0;
    for (const m of dominant) {
      const scaled: LedgerMovement = { ...m, amount: m.amount * scale };
      (e.net > 0 ? pricedIn : pricedOut).push({ movement: scaled, usd: priceLeg(scaled) });
    }
  }
  const sumUsd = (legs: PricedLeg[]) => legs.reduce((sum, l) => sum + (l.usd ?? 0), 0);
  return {
    external,
    hadOwnMove,
    ownMoveUsd,
    ownArrivals,
    pricedIn,
    pricedOut,
    unIn,
    unOut,
    moneyIn: sumUsd(pricedIn),
    moneyOut: sumUsd(pricedOut),
  };
}

interface BridgeSide {
  group: TxGroup;
  legs: PricedLeg[];
  /** 'ETH', 'SOL', 'USD', ... when every leg shares one price basis; null if mixed. */
  unit: string | null;
  amount: number;
  usd: number;
  usdKnown: boolean;
}

export interface BridgeRole {
  side: 'out' | 'in';
  self: BridgeSide;
  pair: BridgeSide;
}

const MINUTE = 60_000;
/** Fast bridges (Relay, Across, CCTP, …) land within minutes and keep a small fee. */
const FAST_WINDOW_MS = 60 * MINUTE;
const FAST_MIN_RATIO = 0.97;
/** Canonical rollup withdrawals take ~7 days but arrive in full. */
const SLOW_WINDOW_MS = 8 * 24 * 60 * MINUTE;
const SLOW_MIN_RATIO = 0.999;
/** Cross-asset hops (SOL → ETH) are matched on USD value. */
const CROSS_ASSET_MIN_RATIO = 0.95;
const CLOCK_SKEW_MS = 10 * MINUTE;

function bridgeSide(group: TxGroup, legs: PricedLeg[]): BridgeSide {
  const units = new Set(legs.map((l) => (l.movement.asset.price?.kind === 'native' ? l.movement.asset.price.symbol : 'USD')));
  return {
    group,
    legs,
    unit: units.size === 1 ? [...units][0] : null,
    amount: legs.reduce((sum, l) => sum + l.movement.amount, 0),
    usd: legs.reduce((sum, l) => sum + (l.usd ?? 0), 0),
    usdKnown: legs.every((l) => l.usd !== null),
  };
}

/**
 * Pair "money left wallet X on chain A" with "money reached one of the user's
 * wallets on chain B" so a bridge isn't counted as spending on one side and
 * income on the other. Candidates are pure money transfers (no NFTs/tokens
 * bought or sold in the same tx). Each outgoing transfer takes the closest
 * eligible arrival in time; amounts must match up to a bridge fee.
 */
export function matchBridges(ordered: TxGroup[], analyses: Map<TxGroup, TxAnalysis>): Map<TxGroup, BridgeRole> {
  const outs: BridgeSide[] = [];
  const ins: BridgeSide[] = [];
  for (const g of ordered) {
    const a = analyses.get(g)!;
    const pureMoney = a.unIn.length === 0 && a.unOut.length === 0;
    if (pureMoney && a.pricedOut.length > 0 && a.pricedIn.length === 0) outs.push(bridgeSide(g, a.pricedOut));
    else if (pureMoney && a.pricedIn.length > 0 && a.pricedOut.length === 0) ins.push(bridgeSide(g, a.pricedIn));
    else if (a.external.length === 0 && a.ownArrivals.length > 0) ins.push(bridgeSide(g, a.ownArrivals));
  }

  const roles = new Map<TxGroup, BridgeRole>();
  const taken = new Set<BridgeSide>();
  for (const out of outs) {
    const t0 = out.group.timestamp.getTime();
    let best: BridgeSide | null = null;
    let bestDt = Infinity;
    for (const cand of ins) {
      if (taken.has(cand) || cand.group.chain === out.group.chain) continue;
      const dt = cand.group.timestamp.getTime() - t0;
      if (dt < -CLOCK_SKEW_MS || dt > SLOW_WINDOW_MS) continue;
      if (!bridgeAmountsMatch(out, cand, dt)) continue;
      if (Math.abs(dt) < bestDt) {
        best = cand;
        bestDt = Math.abs(dt);
      }
    }
    if (best) {
      taken.add(best);
      roles.set(out.group, { side: 'out', self: out, pair: best });
      roles.set(best.group, { side: 'in', self: best, pair: out });
    }
  }
  return roles;
}

function bridgeAmountsMatch(out: BridgeSide, arrival: BridgeSide, dt: number): boolean {
  if (out.unit && out.unit === arrival.unit && out.amount > 0) {
    const ratio = arrival.amount / out.amount;
    if (ratio > 1.0005) return false;
    if (dt <= FAST_WINDOW_MS && ratio >= FAST_MIN_RATIO) return true;
    return ratio >= SLOW_MIN_RATIO;
  }
  if (!out.usdKnown || !arrival.usdKnown || out.usd <= 0 || dt > FAST_WINDOW_MS) return false;
  const ratio = arrival.usd / out.usd;
  return ratio >= CROSS_ASSET_MIN_RATIO && ratio <= 1.01;
}

const CHAIN_NAMES: Record<string, string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  abstract: 'Abstract',
  apechain: 'ApeChain',
  polygon: 'Polygon',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  zora: 'Zora',
  blast: 'Blast',
  linea: 'Linea',
  solana: 'Solana',
};
const chainName = (chain: string) => CHAIN_NAMES[chain] ?? chain;

function priceLegQuiet(pricer: UsdPricer, m: LedgerMovement): number | null {
  if (!m.asset.price) return null;
  const rate = pricer.usdPerUnit(m.asset.price, dayKey(m.timestamp));
  return rate === null ? null : rate * m.amount;
}

function toLeg(m: LedgerMovement, usd: number | null): CashflowActivityLeg {
  return {
    direction: m.direction,
    name: m.asset.name,
    symbol: m.asset.symbol,
    kind: m.asset.kind,
    amount: m.amount,
    tokenId: m.tokenId,
    usd,
  };
}

function formatAmount(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return n.toPrecision(3).replace(/\.?0+$/, '');
}

function assetPhrase(legs: LedgerMovement[]): string {
  if (legs.length === 0) return '';
  const names = new Map<string, { name: string; qty: number; kind: AssetKind; symbol: string | null }>();
  for (const m of legs) {
    const e = names.get(m.asset.key) ?? { name: m.asset.name, qty: 0, kind: m.asset.kind, symbol: m.asset.symbol };
    e.qty += m.amount;
    names.set(m.asset.key, e);
  }
  const parts = [...names.values()].map((e) =>
    e.kind === 'nft' ? (e.qty > 1 ? `${formatAmount(e.qty)} × ${e.name}` : e.name) : `${formatAmount(e.qty)} ${e.symbol ?? e.name}`,
  );
  return parts.length > 2 ? `${parts.slice(0, 2).join(', ')} +${parts.length - 2} more` : parts.join(', ');
}

function describe(
  type: CashflowTxType,
  unIn: LedgerMovement[],
  unOut: LedgerMovement[],
  pricedIn: PricedLeg[],
  pricedOut: PricedLeg[],
): string {
  const moneyIn = assetPhrase(pricedIn.map((l) => l.movement));
  const moneyOut = assetPhrase(pricedOut.map((l) => l.movement));
  switch (type) {
    case 'nft_purchase':
    case 'token_purchase':
      return `Bought ${assetPhrase(unIn)}${moneyOut ? ` for ${moneyOut}` : ''}`;
    case 'nft_mint':
      return `Minted ${assetPhrase(unIn)}${moneyOut ? ` for ${moneyOut}` : ''}`;
    case 'nft_sale':
    case 'token_sale':
      return `Sold ${assetPhrase(unOut)}${moneyIn ? ` for ${moneyIn}` : ''}`;
    case 'swap': {
      const from = assetPhrase(unOut) || moneyOut;
      const to = assetPhrase(unIn) || moneyIn;
      return `Swapped ${from || '?'} → ${to || '?'}`;
    }
    case 'received_asset':
      return unIn.every((m) => m.counterparty === '') ? `Free mint: ${assetPhrase(unIn)}` : `Received ${assetPhrase(unIn)}`;
    case 'sent_asset':
      return unOut.every((m) => m.counterparty === '') ? `Burned ${assetPhrase(unOut)}` : `Sent ${assetPhrase(unOut)}`;
    case 'transfer_out':
      return `Sent ${moneyOut}`;
    case 'transfer_in':
      return `Received ${moneyIn}`;
    case 'own_wallet_transfer':
      return 'Moved between your wallets';
    case 'bridge':
      return 'Bridged between your wallets';
    case 'contract_interaction':
      return 'Contract interaction (gas only)';
  }
}
