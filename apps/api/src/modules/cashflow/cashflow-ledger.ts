import type {
  CashflowActivity,
  CashflowActivityLeg,
  CashflowCategory,
  CashflowChainFees,
  CashflowCounterparty,
  CashflowExchangeSource,
  CashflowExchangeSummary,
  CashflowLinkSource,
  CashflowMonth,
  CashflowNftAcquiredVia,
  CashflowNftDisposedVia,
  CashflowNftItem,
  CashflowPosition,
  CashflowReport,
  CashflowTxType,
  CashflowWalletCoverage,
} from '@nexus/types';
import { nativeSymbolFor, type PriceRef } from './base-assets';

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
  /** Pairs known to be one move between the user's wallets (user links, bridge-service records); applied before auto-matching. */
  explicitLinks?: ExplicitLink[];
  /** Pairs the user said are NOT the same move; auto-matching skips them. */
  rejectedLinks?: TxPair[];
  /** Exchange-owned addresses, keyed by `addressIdentity`. */
  exchangeAddresses?: Map<string, { exchange: string; source: CashflowExchangeSource }>;
}

export interface TxPair {
  fromChain: string;
  fromTxHash: string;
  toChain: string;
  toTxHash: string;
}

export interface ExplicitLink extends TxPair {
  source: Exclude<CashflowLinkSource, 'auto'>;
}

/** Tx hashes are case-insensitive hex on EVM, case-sensitive base58 on Solana. */
export function txKey(chain: string, txHash: string): string {
  return `${chain}:${chain === 'solana' ? txHash : txHash.toLowerCase()}`;
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
  /** Gas paid to acquire these units — kept apart from cost so P/L can be shown before and after gas. */
  gas: number;
  /** The same gas in the chain's own coin (what was actually paid). */
  gasNative: number;
  /** Cost in the chain's own coin, converted at the acquisition-day rate. */
  costNative: number;
  /** Units whose USD cost is unknown (no USD price on the day they were bought). */
  usdMissingQty: number;
}

/** One NFT holding period: acquired once, disposed at most once. */
interface NftTrip {
  tokenId: string;
  qty: number;
  acquiredAt: Date | null;
  acquiredVia: CashflowNftAcquiredVia;
  acquireTxHash: string | null;
  costUsd: number;
  costNative: number;
  buyGasUsd: number;
  buyGasNative: number;
  disposedAt: Date | null;
  disposedVia: CashflowNftDisposedVia | null;
  disposeTxHash: string | null;
  proceedsUsd: number | null;
  proceedsNative: number | null;
  sellGasUsd: number;
  sellGasNative: number;
  /** No USD price on the acquisition day — the USD cost is unknown (the coin cost is still exact). */
  usdMissing: boolean;
}

class Position {
  readonly lots = new Map<string, Lot>();
  /** NFTs only: every holding period, in the order they started. */
  readonly trips: NftTrip[] = [];
  private readonly openTrips = new Map<string, NftTrip[]>();
  buyCount = 0;
  sellCount = 0;
  qtyBought = 0;
  qtySold = 0;
  spentUsd = 0;
  proceedsUsd = 0;
  realizedPnlUsd = 0;
  realizedPnlAfterGasUsd = 0;
  realizedPnlAfterGasNative = 0;
  /** All gas paid on txs that bought, minted, sold, swapped or sent this asset. */
  gasUsd = 0;
  spentNative = 0;
  proceedsNative = 0;
  realizedPnlNative = 0;
  tradeGainUsd = 0;
  priceMoveUsd = 0;
  qtySoldWithoutBasis = 0;
  /** Buys/sales that moved money but had no USD price for the day. */
  usdPriceMissing = 0;
  /** Sales whose USD result is known (both the sale and the purchase were priced). */
  sellCountUsd = 0;
  firstAt: Date;
  lastAt: Date;

  constructor(
    readonly asset: LedgerAsset,
    at: Date,
  ) {
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

  acquire(
    qty: number,
    costUsd: number,
    tokenId: string | null,
    gasUsd = 0,
    costNative = 0,
    gasNative = 0,
    usdMissing = false,
  ) {
    const key = this.lotKey(tokenId);
    const lot = this.lots.get(key) ?? {
      qty: 0,
      cost: 0,
      gas: 0,
      gasNative: 0,
      costNative: 0,
      usdMissingQty: 0,
    };
    lot.qty += qty;
    lot.cost += costUsd;
    if (usdMissing) lot.usdMissingQty += qty;
    lot.gas += gasUsd;
    lot.gasNative += gasNative;
    lot.costNative += costNative;
    this.lots.set(key, lot);
  }

  /** Remove `qty` units; returns the cost basis and acquisition gas removed, and how many units had no known basis. */
  dispose(
    qty: number,
    tokenId: string | null,
  ): {
    basis: number;
    gas: number;
    gasNative: number;
    basisNative: number;
    missing: number;
    /** Units removed whose USD cost was never known. */
    usdMissing: number;
  } {
    const key = this.lotKey(tokenId);
    const lot = this.lots.get(key);
    if (!lot || lot.qty <= EPSILON)
      return { basis: 0, gas: 0, gasNative: 0, basisNative: 0, missing: qty, usdMissing: 0 };
    const take = Math.min(qty, lot.qty);
    const fraction = lot.qty > 0 ? take / lot.qty : 0;
    const basis = lot.cost * fraction;
    const gas = lot.gas * fraction;
    const gasNative = lot.gasNative * fraction;
    const basisNative = lot.costNative * fraction;
    const usdMissing = lot.usdMissingQty * fraction;
    lot.usdMissingQty -= usdMissing;
    lot.qty -= take;
    lot.cost -= basis;
    lot.gas -= gas;
    lot.gasNative -= gasNative;
    lot.costNative -= basisNative;
    if (lot.qty <= EPSILON) this.lots.delete(key);
    const missing = qty - take;
    return {
      basis,
      gas,
      gasNative,
      basisNative,
      missing: missing > EPSILON ? missing : 0,
      usdMissing: usdMissing > EPSILON ? usdMissing : 0,
    };
  }

  /** Start tracking an NFT the user just acquired. */
  openTrip(
    tokenId: string | null,
    qty: number,
    at: Date,
    via: CashflowNftAcquiredVia,
    txHash: string,
    costUsd: number,
    costNative: number,
    gasUsd: number,
    gasNative: number,
    usdMissing = false,
  ) {
    if (this.asset.kind !== 'nft' || tokenId === null) return;
    const trip: NftTrip = {
      tokenId,
      qty,
      acquiredAt: at,
      acquiredVia: via,
      acquireTxHash: txHash,
      costUsd,
      costNative,
      buyGasUsd: gasUsd,
      buyGasNative: gasNative,
      disposedAt: null,
      disposedVia: null,
      disposeTxHash: null,
      proceedsUsd: null,
      proceedsNative: null,
      sellGasUsd: 0,
      sellGasNative: 0,
      usdMissing,
    };
    this.trips.push(trip);
    const open = this.openTrips.get(tokenId) ?? [];
    open.push(trip);
    this.openTrips.set(tokenId, open);
  }

  /**
   * Close `qty` units of an NFT (oldest first). Returns the closed trips so the
   * caller can attach proceeds; a disposal with no recorded acquisition gets a
   * trip with unknown origin and zero cost.
   */
  closeTrips(
    tokenId: string | null,
    qty: number,
    at: Date,
    via: CashflowNftDisposedVia,
    txHash: string,
  ): NftTrip[] {
    if (this.asset.kind !== 'nft' || tokenId === null) return [];
    const open = this.openTrips.get(tokenId) ?? [];
    const closed: NftTrip[] = [];
    let remaining = qty;
    while (remaining > EPSILON && open.length > 0) {
      let trip = open[0];
      if (trip.qty > remaining + EPSILON) {
        // Partial ERC-1155 disposal: split the trip, keep the rest open.
        const fraction = remaining / trip.qty;
        const part: NftTrip = {
          ...trip,
          qty: remaining,
          costUsd: trip.costUsd * fraction,
          costNative: trip.costNative * fraction,
          buyGasUsd: trip.buyGasUsd * fraction,
          buyGasNative: trip.buyGasNative * fraction,
        };
        trip.qty -= remaining;
        trip.costUsd -= part.costUsd;
        trip.costNative -= part.costNative;
        trip.buyGasUsd -= part.buyGasUsd;
        trip.buyGasNative -= part.buyGasNative;
        this.trips.push(part);
        trip = part;
      } else {
        open.shift();
      }
      remaining -= trip.qty;
      closed.push(trip);
    }
    if (remaining > EPSILON) {
      const unknown: NftTrip = {
        tokenId,
        qty: remaining,
        acquiredAt: null,
        acquiredVia: 'unknown',
        acquireTxHash: null,
        costUsd: 0,
        costNative: 0,
        buyGasUsd: 0,
        buyGasNative: 0,
        disposedAt: null,
        disposedVia: null,
        disposeTxHash: null,
        proceedsUsd: null,
        proceedsNative: null,
        sellGasUsd: 0,
        sellGasNative: 0,
        usdMissing: false,
      };
      this.trips.push(unknown);
      closed.push(unknown);
    }
    for (const t of closed) {
      t.disposedAt = at;
      t.disposedVia = via;
      t.disposeTxHash = txHash;
    }
    if (open.length === 0) this.openTrips.delete(tokenId);
    return closed;
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
  /** Value in the tx chain's own coin — exact for native/wrapped-native legs, even with no USD price. */
  native: number | null;
}

export function buildCashflowReport(input: BuildReportInput): CashflowReport {
  const { pricer } = input;
  const own = new Set(input.wallets.map((w) => addressIdentity(w.chain, w.address)));
  const isOwn = (chain: string, addr: string) =>
    addr !== '' && own.has(addressIdentity(chain, addr));

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

  const ordered = [...groups.values()].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.txHash.localeCompare(b.txHash),
  );

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
  const bridgeRoles = matchBridges(
    ordered,
    analyses,
    input.explicitLinks ?? [],
    input.rejectedLinks ?? [],
  );

  // ── Accumulators ──
  const months = new Map<string, CashflowMonth>();
  const monthFor = (d: Date) => {
    const key = monthKey(d);
    let m = months.get(key);
    if (!m) {
      m = {
        month: key,
        inUsd: 0,
        outUsd: 0,
        feesUsd: 0,
        realizedPnlUsd: 0,
        realizedPnlAfterGasUsd: 0,
        byCategory: {},
      };
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
  let totalRealizedAfterGas = 0;

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
  /** USD per unit of the chain's own coin on that day (null if unknown). */
  const nativeRate = (chain: string, d: Date) =>
    pricer.usdPerUnit({ kind: 'native', symbol: nativeSymbolFor(chain) }, dayKey(d));
  const toNative = (usd: number, rate: number | null) => (rate ? usd / rate : 0);
  let totalTradeGain = 0;
  let totalPriceMove = 0;
  const realizedNative: Record<string, number> = {};
  /**
   * Book one realized result: split into what was earned in the coin itself
   * (trade gain, valued at the sale-day price) and the coin's own price move
   * while held. `pnlNative` is null when no sale-day rate exists.
   */
  const bookSplit = (
    p: Position,
    /** null when the USD result is unknown (no USD price on the buy or sale day). */
    realizedUsd: number | null,
    pnlNative: number | null,
    saleRate: number | null,
  ) => {
    if (realizedUsd !== null) {
      const tradeGain = pnlNative !== null && saleRate ? pnlNative * saleRate : realizedUsd;
      p.tradeGainUsd += tradeGain;
      p.priceMoveUsd += realizedUsd - tradeGain;
      totalTradeGain += tradeGain;
      totalPriceMove += realizedUsd - tradeGain;
    }
    if (pnlNative !== null) {
      p.realizedPnlNative += pnlNative;
      const sym = nativeSymbolFor(p.asset.chain);
      realizedNative[sym] = (realizedNative[sym] ?? 0) + pnlNative;
    }
  };

  const exchangeOf = (chain: string, addr: string) =>
    addr ? (input.exchangeAddresses?.get(addressIdentity(chain, addr)) ?? null) : null;
  const exchangeTotals = new Map<string, CashflowExchangeSummary>();

  const bookRealized = (d: Date, usd: number, afterGasUsd: number) => {
    const m = monthFor(d);
    m.realizedPnlUsd += usd;
    m.realizedPnlAfterGasUsd += afterGasUsd;
    totalRealized += usd;
    totalRealizedAfterGas += afterGasUsd;
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
      const ex = exchangeOf(chain, address);
      c = {
        chain,
        address,
        exchange: ex?.exchange ?? null,
        exchangeSource: ex?.source ?? null,
        sentUsd: 0,
        receivedUsd: 0,
        sentCount: 0,
        receivedCount: 0,
        lastAt: at.toISOString(),
      };
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
        const ex = exchangeOf(g.chain, l.movement.counterparty);
        const category: CashflowCategory = ex
          ? dir === 'in'
            ? 'exchange_withdrawal'
            : 'exchange_deposit'
          : dir === 'in'
            ? 'transfer_in'
            : 'transfer_out';
        book(at, dir, category, usd);
        if (ex) {
          const e = exchangeTotals.get(ex.exchange) ?? {
            exchange: ex.exchange,
            depositedUsd: 0,
            withdrawnUsd: 0,
            txCount: 0,
          };
          if (dir === 'in') e.withdrawnUsd += usd;
          else e.depositedUsd += usd;
          e.txCount++;
          exchangeTotals.set(ex.exchange, e);
        }
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
    // Gas is paid in the chain's own coin, so its native amount needs no conversion.
    const feeNative = g.fee && g.fee.feeNative > 0 ? g.fee.feeNative : 0;
    if (g.fee && g.fee.feeNative > 0) {
      const rate = pricer.usdPerUnit({ kind: 'native', symbol: g.fee.symbol }, dayKey(at));
      if (rate === null) unpricedMovements++;
      feeUsd = (rate ?? 0) * g.fee.feeNative;
      const f = feesByChain.get(g.chain) ?? {
        chain: g.chain,
        symbol: g.fee.symbol,
        feesNative: 0,
        feesUsd: 0,
        txCount: 0,
      };
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
    const {
      external,
      hadOwnMove,
      ownMoveUsd,
      pricedIn,
      pricedOut,
      unIn,
      unOut,
      moneyIn,
      moneyOut,
      moneyInNative,
      moneyOutNative,
      moneyUsdKnown,
    } = a;
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
        exchange: null,
        linkedTo: { chain: pair.group.chain, txHash: pair.group.txHash },
        linkSource: bridge.source,
        linkSide: bridge.side,
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
    let exchange: string | null = null;

    if (unIn.length > 0 && unOut.length === 0) {
      // ── Acquisition: purchase, mint, or free receive ──
      const cost = Math.max(0, moneyOut - moneyIn);
      // "Paid" is about money leaving, not about whether we have a USD price
      // for the day — an unpriced ETH mint is still a paid mint.
      const paid = cost > 0 || (!moneyUsdKnown && pricedOut.length > 0);
      const usdMissing = paid && !moneyUsdKnown;
      const costNative =
        moneyOutNative !== null && moneyInNative !== null
          ? Math.max(0, moneyOutNative - moneyInNative)
          : null;
      const share = cost / unIn.length;
      const gasShare = feeUsd / unIn.length;
      const gasShareNative = feeNative / unIn.length;
      const allMint = unIn.every((m) => m.counterparty === '');
      for (const m of unIn) {
        const p = positionFor(m.asset, at);
        const shareNative =
          costNative !== null ? costNative / unIn.length : toNative(share, nativeRate(m.chain, at));
        p.acquire(m.amount, share, m.tokenId, gasShare, shareNative, gasShareNative, usdMissing);
        const via: CashflowNftAcquiredVia = paid
          ? m.counterparty === ''
            ? 'mint'
            : 'purchase'
          : m.counterparty === ''
            ? 'free_mint'
            : 'received';
        p.openTrip(
          m.tokenId,
          m.amount,
          at,
          via,
          g.txHash,
          share,
          shareNative,
          gasShare,
          gasShareNative,
          usdMissing,
        );
        p.gasUsd += gasShare;
        if (paid) {
          p.spentNative += shareNative;
          p.buyCount++;
          p.qtyBought += m.amount;
          p.spentUsd += share;
          if (usdMissing) p.usdPriceMissing++;
          legUsd.set(m, share);
          const category: CashflowCategory =
            m.asset.kind === 'nft'
              ? m.counterparty === ''
                ? 'nft_mint'
                : 'nft_purchase'
              : 'token_purchase';
          book(at, 'out', category, share);
        }
      }
      txOut += cost;
      if (paid) {
        type = unIn.some((m) => m.asset.kind === 'nft')
          ? allMint
            ? 'nft_mint'
            : 'nft_purchase'
          : 'token_purchase';
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
      const proceedsNative =
        moneyInNative !== null && moneyOutNative !== null ? moneyInNative - moneyOutNative : null;
      // Like buys: money arriving makes it a sale even when the day has no USD price.
      const sold =
        proceeds > 0 || (!moneyUsdKnown && pricedIn.length > 0 && (proceedsNative ?? 1) > 0);
      if (sold) {
        // ── Sale ──
        const share = proceeds / unOut.length;
        const gasShare = feeUsd / unOut.length;
        const gasShareNative = feeNative / unOut.length;
        realized = 0;
        let realizedAfterGas = 0;
        for (const m of unOut) {
          const p = positionFor(m.asset, at);
          const d = p.dispose(m.amount, m.tokenId);
          const saleRate = nativeRate(m.chain, at);
          const nativeKnown = proceedsNative !== null || saleRate !== null;
          const shareNative =
            proceedsNative !== null ? proceedsNative / unOut.length : toNative(share, saleRate);
          // USD P/L needs both the sale's and the purchase's USD value.
          const usdOk = moneyUsdKnown && d.usdMissing === 0;
          const pnlNative = nativeKnown ? shareNative - d.basisNative : null;
          for (const t of p.closeTrips(m.tokenId, m.amount, at, 'sale', g.txHash)) {
            const f = t.qty / m.amount;
            t.proceedsUsd = moneyUsdKnown ? share * f : null;
            t.proceedsNative = nativeKnown ? shareNative * f : null;
            t.sellGasUsd = gasShare * f;
            t.sellGasNative = gasShareNative * f;
          }
          if (nativeKnown) {
            p.proceedsNative += shareNative;
            p.realizedPnlAfterGasNative +=
              shareNative - d.basisNative - d.gasNative - gasShareNative;
          }
          bookSplit(p, usdOk ? share - d.basis : null, pnlNative, saleRate);
          p.sellCount++;
          p.qtySold += m.amount;
          p.qtySoldWithoutBasis += d.missing;
          p.gasUsd += gasShare;
          if (moneyUsdKnown) {
            p.proceedsUsd += share;
            book(at, 'in', m.asset.kind === 'nft' ? 'nft_sale' : 'token_sale', share);
            legUsd.set(m, share);
          }
          if (usdOk) {
            p.sellCountUsd++;
            p.realizedPnlUsd += share - d.basis;
            // After gas: also subtract the gas paid to acquire these units and this sale's gas.
            p.realizedPnlAfterGasUsd += share - d.basis - d.gas - gasShare;
            realized += share - d.basis;
            realizedAfterGas += share - d.basis - d.gas - gasShare;
          } else {
            p.usdPriceMissing++;
          }
        }
        bookRealized(at, realized, realizedAfterGas);
        txIn += proceeds;
        type = unOut.some((m) => m.asset.kind === 'nft') ? 'nft_sale' : 'token_sale';
      } else {
        // ── Gave an asset away (gift, move to an unlinked wallet, burn) ──
        for (const m of unOut) {
          const p = positionFor(m.asset, at);
          p.dispose(m.amount, m.tokenId);
          p.gasUsd += feeUsd / unOut.length;
          for (const t of p.closeTrips(
            m.tokenId,
            m.amount,
            at,
            m.counterparty === '' ? 'burned' : 'sent',
            g.txHash,
          )) {
            t.sellGasUsd = (feeUsd / unOut.length) * (t.qty / m.amount);
            t.sellGasNative = (feeNative / unOut.length) * (t.qty / m.amount);
          }
        }
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
      // Acquisition gas of what's given up, plus this swap's gas, rides along into what's received.
      let carriedGas = feeUsd;
      let carriedGasNative = feeNative;
      let carriedNative = 0;
      // Unknown USD cost on what's given up (or on this tx's money) stays unknown on what's received.
      let carriedUsdMissing = !moneyUsdKnown;
      for (const m of unOut) {
        const p = positionFor(m.asset, at);
        const d = p.dispose(m.amount, m.tokenId);
        if (d.usdMissing > 0) carriedUsdMissing = true;
        p.closeTrips(m.tokenId, m.amount, at, 'swap', g.txHash);
        carried += d.basis;
        carriedGas += d.gas;
        carriedGasNative += d.gasNative;
        carriedNative += d.basisNative;
      }
      const netMoney = moneyOut - moneyIn;
      const swapRate = nativeRate(g.chain, at);
      if (netMoney < 0) {
        // Received money on top: realize it as a zero-basis sale.
        realized = -netMoney;
        bookRealized(at, realized, realized);
        const p = positionFor(unOut[0].asset, at);
        p.realizedPnlUsd += realized;
        p.realizedPnlAfterGasUsd += realized;
        if (swapRate) p.realizedPnlAfterGasNative += realized / swapRate;
        bookSplit(p, realized, swapRate ? realized / swapRate : null, swapRate);
        book(at, 'in', 'token_sale', -netMoney);
        txIn += -netMoney;
      } else if (netMoney > 0) {
        book(at, 'out', unIn[0].asset.kind === 'nft' ? 'nft_purchase' : 'token_purchase', netMoney);
        txOut += netMoney;
      }
      const basis = carried + Math.max(0, netMoney);
      const share = basis / unIn.length;
      const netMoneyNative =
        moneyOutNative !== null && moneyInNative !== null
          ? Math.max(0, moneyOutNative - moneyInNative)
          : toNative(Math.max(0, netMoney), swapRate);
      const basisNative = carriedNative + netMoneyNative;
      for (const m of unIn) {
        const p = positionFor(m.asset, at);
        p.acquire(
          m.amount,
          share,
          m.tokenId,
          carriedGas / unIn.length,
          basisNative / unIn.length,
          carriedGasNative / unIn.length,
          carriedUsdMissing,
        );
        p.openTrip(
          m.tokenId,
          m.amount,
          at,
          'swap',
          g.txHash,
          share,
          basisNative / unIn.length,
          carriedGas / unIn.length,
          carriedGasNative / unIn.length,
          carriedUsdMissing,
        );
        legUsd.set(m, share);
      }
      for (const m of [...unIn, ...unOut])
        positionFor(m.asset, at).gasUsd += feeUsd / (unIn.length + unOut.length);
      type = 'swap';
    } else if (pricedIn.length > 0 && pricedOut.length > 0) {
      // Money-for-money (ETH→USDC, wrapping): a conversion, not spending.
      type = 'swap';
    } else if (pricedOut.length > 0) {
      bookTransfers(pricedOut, 'out');
      txOut += moneyOut;
      counterparty = pricedOut[0].movement.counterparty || null;
      exchange = exchangeOf(g.chain, pricedOut[0].movement.counterparty)?.exchange ?? null;
      type = exchange ? 'exchange_deposit' : 'transfer_out';
    } else if (pricedIn.length > 0) {
      bookTransfers(pricedIn, 'in');
      txIn += moneyIn;
      counterparty = pricedIn[0].movement.counterparty || null;
      exchange = exchangeOf(g.chain, pricedIn[0].movement.counterparty)?.exchange ?? null;
      type = exchange ? 'exchange_withdrawal' : 'transfer_in';
    } else {
      type = hadOwnMove ? 'own_wallet_transfer' : 'contract_interaction';
    }

    if (hadOwnMove) {
      ownTransfers.count++;
      ownTransfers.usd += ownMoveUsd;
    }

    if (external.length === 0 && type !== 'own_wallet_transfer' && type !== 'contract_interaction')
      continue;

    for (const l of [...pricedIn, ...pricedOut]) legUsd.set(l.movement, l.usd ?? 0);
    const legs: CashflowActivityLeg[] = [...pricedIn, ...pricedOut].map((l) =>
      toLeg(l.movement, l.usd),
    );
    for (const m of [...unIn, ...unOut]) legs.push(toLeg(m, legUsd.get(m) ?? null));

    activity.push({
      chain: g.chain,
      txHash: g.txHash,
      timestamp: at.toISOString(),
      wallet: g.wallet,
      type,
      label: describe(type, unIn, unOut, pricedIn, pricedOut, exchange),
      inUsd: txIn,
      outUsd: txOut,
      feeUsd,
      realizedPnlUsd: realized,
      counterparty,
      exchange,
      linkedTo: null,
      linkSource: null,
      linkSide: null,
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
      realizedPnlAfterGasUsd: p.realizedPnlAfterGasUsd,
      realizedPnlAfterGasNative: p.realizedPnlAfterGasNative,
      gasUsd: p.gasUsd,
      nativeSymbol: nativeSymbolFor(p.asset.chain),
      spentNative: p.spentNative,
      proceedsNative: p.proceedsNative,
      realizedPnlNative: p.realizedPnlNative,
      tradeGainUsd: p.tradeGainUsd,
      priceMoveUsd: p.priceMoveUsd,
      openCostBasisUsd: p.openCost,
      qtySoldWithoutBasis: p.qtySoldWithoutBasis,
      usdPriceMissing: p.usdPriceMissing,
      sellCountUsd: p.sellCountUsd,
      firstAt: p.firstAt.toISOString(),
      lastAt: p.lastAt.toISOString(),
      items: p.trips.map(toNftItem).sort(newestFirst).slice(0, MAX_ITEMS_PER_COLLECTION),
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
      monthRows.push(
        months.get(key) ?? {
          month: key,
          inUsd: 0,
          outUsd: 0,
          feesUsd: 0,
          realizedPnlUsd: 0,
          realizedPnlAfterGasUsd: 0,
          byCategory: {},
        },
      );
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
      realizedPnlAfterGasUsd: totalRealizedAfterGas,
      tradeGainUsd: totalTradeGain,
      priceMoveUsd: totalPriceMove,
      realizedPnlNative: realizedNative,
      onRampUsd: inByCategory.exchange_withdrawal ?? 0,
      offRampUsd: outByCategory.exchange_deposit ?? 0,
      netInvestedUsd:
        (inByCategory.exchange_withdrawal ?? 0) - (outByCategory.exchange_deposit ?? 0),
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
    exchanges: [...exchangeTotals.values()].sort(
      (a, b) => b.depositedUsd + b.withdrawnUsd - (a.depositedUsd + a.withdrawnUsd),
    ),
    links: [],
    addressTags: [],
    exchangeNames: [],
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
  /** USD value of the money legs (unpriced legs count as 0 — see moneyUsdKnown). */
  moneyIn: number;
  moneyOut: number;
  /** Money legs in the chain's own coin; null if a leg couldn't be converted. */
  moneyInNative: number | null;
  moneyOutNative: number | null;
  /** False when a money leg had no USD price for its day. */
  moneyUsdKnown: boolean;
}

function analyze(
  g: TxGroup,
  isOwn: (chain: string, addr: string) => boolean,
  priceLeg: (m: LedgerMovement) => number | null,
  pricer: UsdPricer,
): TxAnalysis {
  // Value money legs in the chain's own coin: exact for the coin (and its
  // wrapped form) itself, converted via USD for anything else.
  const chainSymbol = nativeSymbolFor(g.chain);
  const chainRate = pricer.usdPerUnit({ kind: 'native', symbol: chainSymbol }, dayKey(g.timestamp));
  const leg = (m: LedgerMovement, usd: number | null): PricedLeg => ({
    movement: m,
    usd,
    native:
      m.asset.price?.kind === 'native' && m.asset.price.symbol === chainSymbol
        ? m.amount
        : usd !== null && chainRate
          ? usd / chainRate
          : null,
  });
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
      if (m.asset.price) ownArrivals.push(leg(m, priceLegQuiet(pricer, m)));
    }
  }

  // Net money legs per asset (e.g. pay 1 ETH, get 0.2 ETH refund).
  const pricedIn: PricedLeg[] = [];
  const pricedOut: PricedLeg[] = [];
  const unIn: LedgerMovement[] = [];
  const unOut: LedgerMovement[] = [];
  const netByAsset = new Map<
    string,
    { in: LedgerMovement[]; out: LedgerMovement[]; net: number }
  >();
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
      (e.net > 0 ? pricedIn : pricedOut).push(leg(scaled, priceLeg(scaled)));
    }
  }
  const sumUsd = (legs: PricedLeg[]) => legs.reduce((sum, l) => sum + (l.usd ?? 0), 0);
  const sumNative = (legs: PricedLeg[]) =>
    legs.every((l) => l.native !== null) ? legs.reduce((sum, l) => sum + l.native!, 0) : null;
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
    moneyInNative: sumNative(pricedIn),
    moneyOutNative: sumNative(pricedOut),
    moneyUsdKnown: [...pricedIn, ...pricedOut].every((l) => l.usd !== null),
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
  source: CashflowLinkSource;
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
  const units = new Set(
    legs.map((l) =>
      l.movement.asset.price?.kind === 'native' ? l.movement.asset.price.symbol : 'USD',
    ),
  );
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
export function matchBridges(
  ordered: TxGroup[],
  analyses: Map<TxGroup, TxAnalysis>,
  explicit: ExplicitLink[] = [],
  rejected: TxPair[] = [],
): Map<TxGroup, BridgeRole> {
  const roles = new Map<TxGroup, BridgeRole>();
  const byKey = new Map(ordered.map((g) => [txKey(g.chain, g.txHash), g]));

  // Explicit links win: they're either the user's word or the bridge's own record.
  for (const link of explicit) {
    const from = byKey.get(txKey(link.fromChain, link.fromTxHash));
    const to = byKey.get(txKey(link.toChain, link.toTxHash));
    if (!from || !to || from === to || roles.has(from) || roles.has(to)) continue;
    const fa = analyses.get(from)!;
    const ta = analyses.get(to)!;
    const outLegs = fa.pricedOut;
    const inLegs = ta.pricedIn.length > 0 ? ta.pricedIn : ta.ownArrivals;
    if (outLegs.length === 0 || inLegs.length === 0) continue;
    const out = bridgeSide(from, outLegs);
    const arrival = bridgeSide(to, inLegs);
    roles.set(from, { side: 'out', self: out, pair: arrival, source: link.source });
    roles.set(to, { side: 'in', self: arrival, pair: out, source: link.source });
  }

  const rejectedKeys = new Set(
    rejected.flatMap((r) => {
      const a = txKey(r.fromChain, r.fromTxHash);
      const b = txKey(r.toChain, r.toTxHash);
      return [`${a}>${b}`, `${b}>${a}`];
    }),
  );

  const outs: BridgeSide[] = [];
  const ins: BridgeSide[] = [];
  for (const g of ordered) {
    if (roles.has(g)) continue;
    const a = analyses.get(g)!;
    const pureMoney = a.unIn.length === 0 && a.unOut.length === 0;
    if (pureMoney && a.pricedOut.length > 0 && a.pricedIn.length === 0)
      outs.push(bridgeSide(g, a.pricedOut));
    else if (pureMoney && a.pricedIn.length > 0 && a.pricedOut.length === 0)
      ins.push(bridgeSide(g, a.pricedIn));
    else if (a.external.length === 0 && a.ownArrivals.length > 0)
      ins.push(bridgeSide(g, a.ownArrivals));
  }

  const taken = new Set<BridgeSide>();
  for (const out of outs) {
    const t0 = out.group.timestamp.getTime();
    let best: BridgeSide | null = null;
    let bestDt = Infinity;
    for (const cand of ins) {
      if (taken.has(cand) || cand.group.chain === out.group.chain) continue;
      if (
        rejectedKeys.has(
          `${txKey(out.group.chain, out.group.txHash)}>${txKey(cand.group.chain, cand.group.txHash)}`,
        )
      )
        continue;
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
      roles.set(out.group, { side: 'out', self: out, pair: best, source: 'auto' });
      roles.set(best.group, { side: 'in', self: best, pair: out, source: 'auto' });
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

/** Keeps very large collections from bloating the report; newest trips win. */
const MAX_ITEMS_PER_COLLECTION = 1000;

function toNftItem(t: NftTrip): CashflowNftItem {
  const sold = t.disposedVia === 'sale';
  const realized =
    sold && t.proceedsUsd !== null && !t.usdMissing ? t.proceedsUsd - t.costUsd : null;
  const pnlNative = sold && t.proceedsNative !== null ? t.proceedsNative - t.costNative : null;
  return {
    tokenId: t.tokenId,
    qty: t.qty,
    acquiredAt: t.acquiredAt?.toISOString() ?? null,
    acquiredVia: t.acquiredVia,
    acquireTxHash: t.acquireTxHash,
    costUsd: t.usdMissing ? null : t.costUsd,
    costNative: t.costNative,
    buyGasUsd: t.buyGasUsd,
    buyGasNative: t.buyGasNative,
    disposedAt: t.disposedAt?.toISOString() ?? null,
    disposedVia: t.disposedVia,
    disposeTxHash: t.disposeTxHash,
    proceedsUsd: t.proceedsUsd,
    proceedsNative: t.proceedsNative,
    sellGasUsd: t.sellGasUsd,
    sellGasNative: t.sellGasNative,
    realizedPnlUsd: realized,
    realizedPnlAfterGasUsd: realized === null ? null : realized - t.buyGasUsd - t.sellGasUsd,
    realizedPnlNative: pnlNative,
    realizedPnlAfterGasNative:
      pnlNative === null ? null : pnlNative - t.buyGasNative - t.sellGasNative,
    usdPriceMissing: t.usdMissing || (sold && t.proceedsUsd === null),
    holdSeconds:
      t.acquiredAt && t.disposedAt
        ? Math.round((t.disposedAt.getTime() - t.acquiredAt.getTime()) / 1000)
        : null,
  };
}

/** Most recent activity first; still-held items sort by when they were acquired. */
function newestFirst(a: CashflowNftItem, b: CashflowNftItem): number {
  const ka = a.disposedAt ?? a.acquiredAt ?? '';
  const kb = b.disposedAt ?? b.acquiredAt ?? '';
  return kb.localeCompare(ka);
}

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
  const names = new Map<
    string,
    { name: string; qty: number; kind: AssetKind; symbol: string | null }
  >();
  for (const m of legs) {
    const e = names.get(m.asset.key) ?? {
      name: m.asset.name,
      qty: 0,
      kind: m.asset.kind,
      symbol: m.asset.symbol,
    };
    e.qty += m.amount;
    names.set(m.asset.key, e);
  }
  const parts = [...names.values()].map((e) =>
    e.kind === 'nft'
      ? e.qty > 1
        ? `${formatAmount(e.qty)} × ${e.name}`
        : e.name
      : `${formatAmount(e.qty)} ${e.symbol ?? e.name}`,
  );
  return parts.length > 2
    ? `${parts.slice(0, 2).join(', ')} +${parts.length - 2} more`
    : parts.join(', ');
}

function describe(
  type: CashflowTxType,
  unIn: LedgerMovement[],
  unOut: LedgerMovement[],
  pricedIn: PricedLeg[],
  pricedOut: PricedLeg[],
  exchange: string | null = null,
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
      return unIn.every((m) => m.counterparty === '')
        ? `Free mint: ${assetPhrase(unIn)}`
        : `Received ${assetPhrase(unIn)}`;
    case 'sent_asset':
      return unOut.every((m) => m.counterparty === '')
        ? `Burned ${assetPhrase(unOut)}`
        : `Sent ${assetPhrase(unOut)}`;
    case 'transfer_out':
      return `Sent ${moneyOut}`;
    case 'transfer_in':
      return `Received ${moneyIn}`;
    case 'exchange_deposit':
      return `Cashed out ${moneyOut} to ${exchange ?? 'an exchange'}`;
    case 'exchange_withdrawal':
      return `Deposited ${moneyIn} from ${exchange ?? 'an exchange'}`;
    case 'own_wallet_transfer':
      return 'Moved between your wallets';
    case 'bridge':
      return 'Bridged between your wallets';
    case 'contract_interaction':
      return 'Contract interaction (gas only)';
  }
}
