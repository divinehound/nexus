import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { cashflowAddressTags, cashflowTxLinks, collections, wallets, type Database } from '@nexus/database';
import type {
  CashflowAddressTag,
  CashflowExchangeSource,
  CashflowReport,
  CashflowResponse,
  CashflowTxLink,
  CashflowWalletCoverage,
} from '@nexus/types';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { PriceOracleService, nativeTokenForChain, toDayKey } from '../admin/price-oracle.service';
import {
  addressIdentity,
  buildCashflowReport,
  txKey,
  type ExplicitLink,
  type LedgerAsset,
  type LedgerFee,
  type LedgerMovement,
  type UsdPricer,
} from './cashflow-ledger';
import { EVM_CHAINS, EvmActivityFetcher, shortAddress, type ChainFetchResult } from './evm-activity.fetcher';
import { EVM_EXCHANGE_WALLETS, EXCHANGE_NAMES } from './exchange-wallets';
import { RelayLinksFetcher } from './relay-links.fetcher';
import { SolanaActivityFetcher } from './solana-activity.fetcher';
import type { PriceRef } from './base-assets';

/** Chain whose native coin (per PriceOracleService) prices each money symbol. */
const PRICED_SYMBOLS: Record<string, string> = { ETH: 'ethereum', POL: 'polygon', APE: 'apechain', SOL: 'solana' };

/** A daily rate this many days away is still a reasonable stand-in for a missing day. */
const MAX_PRICE_GAP_DAYS = 7;
const MAX_CACHED_USERS = 200;
/** How many of the biggest send-to addresses get checked for being exchange deposit addresses. */
const MAX_DEPOSIT_ADDRESS_CHECKS = 25;

/** Everything fetched from chain/price providers — enough to rebuild the report without rescanning. */
interface ScanData {
  wallets: Array<{ chain: string; address: string }>;
  movements: LedgerMovement[];
  fees: LedgerFee[];
  pricer: UsdPricer;
  coverage: CashflowWalletCoverage[];
  notes: string[];
  relayLinks: ExplicitLink[];
  /** Exchange deposit addresses spotted by where they sweep funds, keyed by addressIdentity. */
  detectedExchanges: Map<string, string>;
}

interface Entry {
  status: 'computing' | 'ready' | 'failed';
  startedAt: Date;
  progress: string;
  report: CashflowReport | null;
  error: string | null;
  walletsSignature: string;
  scan: ScanData | null;
}

export interface TxLinkInput {
  kind: 'link' | 'unlink';
  fromChain: string;
  fromTxHash: string;
  toChain: string;
  toTxHash: string;
}

export interface AddressTagInput {
  chain: string;
  address: string;
  exchange: string;
}

/**
 * Builds the per-user cash-flow report on demand. Scanning full wallet history
 * can take minutes for active wallets, so the work runs in the background and
 * the endpoint is polled; finished reports are kept in memory until the user
 * refreshes or links/unlinks a wallet.
 */
@Injectable()
export class CashflowService {
  private readonly logger = new Logger(CashflowService.name);
  private readonly entries = new Map<string, Entry>();

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
    private readonly priceOracle: PriceOracleService,
  ) {}

  async getReport(userId: string, refresh: boolean): Promise<CashflowResponse> {
    const linked = await this.db.query.wallets.findMany({ where: eq(wallets.userId, userId) });
    if (linked.length === 0) return { status: 'no_wallets' };
    const signature = linked.map((w) => `${w.chain}:${w.address}`).sort().join('|');

    const entry = this.entries.get(userId);
    if (entry?.status === 'computing') return this.toResponse(entry);
    if (entry && !refresh && entry.walletsSignature === signature) return this.toResponse(entry);

    const next: Entry = {
      status: 'computing',
      startedAt: new Date(),
      progress: 'Starting…',
      report: entry?.report ?? null,
      error: null,
      walletsSignature: signature,
      scan: null,
    };
    this.remember(userId, next);
    const targets = linked.map((w) => ({ chain: w.chain as string, address: w.address }));
    this.scan(targets, next)
      .then(async (scan) => {
        next.scan = scan;
        next.progress = 'Crunching numbers…';
        next.report = await this.buildFromScan(userId, scan);
        next.status = 'ready';
      })
      .catch((err: Error) => {
        this.logger.error(`Cash-flow report failed for user ${userId}: ${err.message}`, err.stack);
        next.status = 'failed';
        next.error = err.message;
      });
    return this.toResponse(next);
  }

  /**
   * Re-run the (fast, pure) ledger over the last scan with the user's current
   * links and tags — no chain calls. Falls back to a normal load if nothing has
   * been scanned yet.
   */
  async rebuild(userId: string): Promise<CashflowResponse> {
    const entry = this.entries.get(userId);
    if (!entry?.scan || entry.status === 'computing') return this.getReport(userId, false);
    entry.report = await this.buildFromScan(userId, entry.scan);
    entry.status = 'ready';
    return this.toResponse(entry);
  }

  // ── User overrides ──

  async addLink(userId: string, input: TxLinkInput): Promise<CashflowResponse> {
    const pair = { fromChain: input.fromChain, fromTxHash: input.fromTxHash, toChain: input.toChain, toTxHash: input.toTxHash };
    // Linking and rejecting the same pair are mutually exclusive; the latest word wins.
    await this.db
      .delete(cashflowTxLinks)
      .where(
        and(
          eq(cashflowTxLinks.userId, userId),
          sql`(${cashflowTxLinks.fromChain} = ${pair.fromChain} AND ${cashflowTxLinks.fromTxHash} = ${pair.fromTxHash} AND ${cashflowTxLinks.toChain} = ${pair.toChain} AND ${cashflowTxLinks.toTxHash} = ${pair.toTxHash})
            OR (${cashflowTxLinks.fromChain} = ${pair.toChain} AND ${cashflowTxLinks.fromTxHash} = ${pair.toTxHash} AND ${cashflowTxLinks.toChain} = ${pair.fromChain} AND ${cashflowTxLinks.toTxHash} = ${pair.fromTxHash})`,
        ),
      );
    // A tx can only be half of one manual link.
    if (input.kind === 'link') {
      await this.db
        .delete(cashflowTxLinks)
        .where(
          and(
            eq(cashflowTxLinks.userId, userId),
            eq(cashflowTxLinks.kind, 'link'),
            sql`(${cashflowTxLinks.fromChain} = ${pair.fromChain} AND ${cashflowTxLinks.fromTxHash} = ${pair.fromTxHash})
              OR (${cashflowTxLinks.toChain} = ${pair.toChain} AND ${cashflowTxLinks.toTxHash} = ${pair.toTxHash})`,
          ),
        );
    }
    await this.db
      .insert(cashflowTxLinks)
      .values({ userId, kind: input.kind, ...pair })
      .onConflictDoNothing();
    return this.rebuild(userId);
  }

  async removeLink(userId: string, id: string): Promise<CashflowResponse> {
    await this.db.delete(cashflowTxLinks).where(and(eq(cashflowTxLinks.userId, userId), eq(cashflowTxLinks.id, id)));
    return this.rebuild(userId);
  }

  async addAddressTag(userId: string, input: AddressTagInput): Promise<CashflowResponse> {
    const chainFamily = input.chain === 'solana' ? 'solana' : 'evm';
    const address = chainFamily === 'evm' ? input.address.toLowerCase() : input.address;
    await this.db
      .insert(cashflowAddressTags)
      .values({ userId, chainFamily, address, exchange: input.exchange })
      .onConflictDoUpdate({
        target: [cashflowAddressTags.userId, cashflowAddressTags.chainFamily, cashflowAddressTags.address],
        set: { exchange: input.exchange },
      });
    return this.rebuild(userId);
  }

  async removeAddressTag(userId: string, id: string): Promise<CashflowResponse> {
    await this.db.delete(cashflowAddressTags).where(and(eq(cashflowAddressTags.userId, userId), eq(cashflowAddressTags.id, id)));
    return this.rebuild(userId);
  }

  private async buildFromScan(userId: string, scan: ScanData): Promise<CashflowReport> {
    const [linkRows, tagRows] = await Promise.all([
      this.db.select().from(cashflowTxLinks).where(eq(cashflowTxLinks.userId, userId)),
      this.db.select().from(cashflowAddressTags).where(eq(cashflowAddressTags.userId, userId)),
    ]);
    const links: CashflowTxLink[] = linkRows.map((r) => ({
      id: r.id,
      kind: r.kind === 'unlink' ? 'unlink' : 'link',
      fromChain: r.fromChain,
      fromTxHash: r.fromTxHash,
      toChain: r.toChain,
      toTxHash: r.toTxHash,
    }));
    const addressTags: CashflowAddressTag[] = tagRows.map((r) => ({
      id: r.id,
      chainFamily: r.chainFamily === 'solana' ? 'solana' : 'evm',
      address: r.address,
      exchange: r.exchange,
    }));

    const rejected = links.filter((l) => l.kind === 'unlink');
    const rejectedKeys = new Set(
      rejected.flatMap((r) => {
        const a = txKey(r.fromChain, r.fromTxHash);
        const b = txKey(r.toChain, r.toTxHash);
        return [`${a}>${b}`, `${b}>${a}`];
      }),
    );
    const explicitLinks: ExplicitLink[] = [
      // Manual links first: the user's word beats Relay's record for the same tx.
      ...links.filter((l) => l.kind === 'link').map((l) => ({ ...l, source: 'manual' as const })),
      ...scan.relayLinks.filter((l) => !rejectedKeys.has(`${txKey(l.fromChain, l.fromTxHash)}>${txKey(l.toChain, l.toTxHash)}`)),
    ];

    // Tagged beats detected beats the public list.
    const exchangeAddresses = new Map<string, { exchange: string; source: CashflowExchangeSource }>();
    for (const [address, exchange] of EVM_EXCHANGE_WALLETS) exchangeAddresses.set(`evm:${address}`, { exchange, source: 'known' });
    for (const [identity, exchange] of scan.detectedExchanges) exchangeAddresses.set(identity, { exchange, source: 'detected' });
    for (const t of addressTags) {
      exchangeAddresses.set(addressIdentity(t.chainFamily === 'solana' ? 'solana' : 'ethereum', t.address), { exchange: t.exchange, source: 'tagged' });
    }

    const report = buildCashflowReport({
      movements: scan.movements,
      fees: scan.fees,
      wallets: scan.wallets,
      pricer: scan.pricer,
      coverage: scan.coverage,
      notes: [...scan.notes],
      now: new Date(),
      explicitLinks,
      rejectedLinks: rejected,
      exchangeAddresses,
    });
    if (report.totals.unpricedMovements > 0) {
      report.notes.push(
        `${report.totals.unpricedMovements} movements had no USD price for their day and count as $0 (historical prices older than a year need a paid CoinGecko key).`,
      );
    }
    report.links = links;
    report.addressTags = addressTags;
    report.exchangeNames = EXCHANGE_NAMES;
    return report;
  }

  private toResponse(entry: Entry): CashflowResponse {
    if (entry.status === 'ready' && entry.report) return { status: 'ready', report: entry.report };
    if (entry.status === 'failed') return { status: 'failed', error: entry.error ?? 'Unknown error', previous: entry.report };
    return { status: 'computing', startedAt: entry.startedAt.toISOString(), progress: entry.progress, previous: entry.report };
  }

  private remember(userId: string, entry: Entry) {
    this.entries.delete(userId);
    this.entries.set(userId, entry);
    // Map iteration order is insertion order, so the first key is the stalest.
    while (this.entries.size > MAX_CACHED_USERS) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  private async scan(linked: Array<{ chain: string; address: string }>, entry: Entry): Promise<ScanData> {
    const alchemyKey = this.config.get<string>('alchemy.apiKey');
    const heliusKey = this.config.get<string>('helius.apiKey') || this.config.get<string>('HELIUS_API_KEY');
    const notes: string[] = [];

    // An EVM address is the same wallet on every EVM chain — scan them all.
    const evmAddresses = [...new Set(linked.filter((w) => w.chain !== 'solana').map((w) => w.address.toLowerCase()))];
    const solAddresses = [...new Set(linked.filter((w) => w.chain === 'solana').map((w) => w.address))];
    const jobs: Array<{ chain: string; address: string; run: (assets: Map<string, LedgerAsset>) => Promise<ChainFetchResult> }> = [];
    if (evmAddresses.length > 0 && !alchemyKey) notes.push('EVM wallets were skipped: ALCHEMY_API_KEY is not configured.');
    if (solAddresses.length > 0 && !heliusKey) notes.push('Solana wallets were skipped: HELIUS_API_KEY is not configured.');
    if (alchemyKey) {
      const evm = new EvmActivityFetcher(alchemyKey);
      for (const address of evmAddresses) for (const chain of EVM_CHAINS) jobs.push({ chain, address, run: (a) => evm.fetch(chain, address, a) });
    }
    if (heliusKey) {
      const sol = new SolanaActivityFetcher(heliusKey);
      for (const address of solAddresses) jobs.push({ chain: 'solana', address, run: (a) => sol.fetch(address, a) });
    }

    const assets = new Map<string, LedgerAsset>();
    const movements: LedgerMovement[] = [];
    const fees: LedgerFee[] = [];
    const coverage: CashflowWalletCoverage[] = [];
    const disabledNetworks = new Set<string>();
    for (const [i, job] of jobs.entries()) {
      entry.progress = `Scanning ${job.chain} ${shortAddress(job.address)} (${i + 1}/${jobs.length})`;
      try {
        const r = await job.run(assets);
        movements.push(...r.movements);
        fees.push(...r.fees);
        notes.push(...r.notes);
        coverage.push({ chain: job.chain, address: job.address, transfers: r.transfers, truncated: r.truncated, error: null });
      } catch (err) {
        const message = (err as Error).message;
        if (job.chain !== 'solana' && /HTTP 403|not enabled|unsupported network/i.test(message)) {
          // Networks have to be enabled per Alchemy app; one that isn't is a config gap, not a failure.
          disabledNetworks.add(job.chain);
          continue;
        }
        this.logger.warn(`Cash-flow scan failed for ${job.chain} ${job.address}: ${message}`);
        coverage.push({ chain: job.chain, address: job.address, transfers: 0, truncated: false, error: message });
      }
    }

    if (disabledNetworks.size > 0) {
      notes.push(
        `Not scanned — enable these networks on the Alchemy app to include them: ${[...disabledNetworks].join(', ')}. Bridges to them will show as money out.`,
      );
    }

    entry.progress = 'Looking up collection names…';
    await this.enrichNftNames(assets, alchemyKey);

    entry.progress = 'Pricing transactions…';
    const pricer = await this.buildPricer(movements, fees);

    if (coverage.some((c) => c.truncated)) {
      notes.push('Some very active wallets hit the scan limit; the oldest history beyond it is not included.');
    }
    notes.push(
      'NFT and token values come from what you paid or received in ETH/SOL/POL/APE, their wrapped versions, or stablecoins in the same transaction.',
    );
    if (evmAddresses.length > 0 && alchemyKey) {
      notes.push('Outside Ethereum and Polygon, NFT sale proceeds paid out by a contract in native ETH/APE cannot be traced yet; WETH/stablecoin proceeds are.');
    }

    entry.progress = 'Checking bridge records…';
    const relayLinks = await this.fetchRelayLinks([...evmAddresses, ...solAddresses], notes);

    entry.progress = 'Checking which transfers went to exchanges…';
    const own = new Set(linked.map((w) => addressIdentity(w.chain, w.address)));
    const detectedExchanges = alchemyKey
      ? await this.detectExchangeDepositAddresses(new EvmActivityFetcher(alchemyKey), movements, pricer, own)
      : new Map<string, string>();

    return {
      wallets: linked.map((w) => ({ chain: w.chain, address: w.address })),
      movements,
      fees,
      pricer,
      coverage,
      notes,
      relayLinks,
      detectedExchanges,
    };
  }

  private async fetchRelayLinks(addresses: string[], notes: string[]): Promise<ExplicitLink[]> {
    const apiKey = this.config.get<string>('relay.apiKey');
    if (!apiKey) {
      notes.push('Relay bridges are paired by amount and timing; set RELAY_API_KEY to pair them exactly from Relay\'s records.');
      return [];
    }
    const relay = new RelayLinksFetcher(apiKey);
    const links: ExplicitLink[] = [];
    for (const address of addresses) {
      try {
        links.push(...(await relay.fetchLinks(address)));
      } catch (err) {
        this.logger.warn(`Relay history lookup failed for ${address}: ${(err as Error).message}`);
        notes.push(`Couldn't load Relay history for ${shortAddress(address)}; its bridges fall back to amount/timing matching.`);
      }
    }
    return links;
  }

  /**
   * Exchanges give each customer a personal deposit address that forwards
   * ("sweeps") everything into the exchange's main wallets. For the addresses
   * the user sent the most money to, look at where *they* sent money next: if
   * it's a known exchange wallet, that address is the user's exchange account.
   */
  private async detectExchangeDepositAddresses(
    evm: EvmActivityFetcher,
    movements: LedgerMovement[],
    pricer: UsdPricer,
    own: Set<string>,
  ): Promise<Map<string, string>> {
    // Plain money sends only (no NFT/token legs in the same tx).
    const txHasAsset = new Set(movements.filter((m) => !m.asset.price).map((m) => `${m.chain}:${m.txHash}`));
    const sentTo = new Map<string, { chain: string; address: string; usd: number }>();
    for (const m of movements) {
      if (m.chain === 'solana' || m.direction !== 'out' || !m.asset.price || !m.counterparty) continue;
      if (txHasAsset.has(`${m.chain}:${m.txHash}`)) continue;
      const identity = addressIdentity(m.chain, m.counterparty);
      if (own.has(identity) || EVM_EXCHANGE_WALLETS.has(m.counterparty.toLowerCase())) continue;
      const usd = (pricer.usdPerUnit(m.asset.price, toDayKey(m.timestamp)) ?? 0) * m.amount;
      const key = `${identity}@${m.chain}`;
      const e = sentTo.get(key) ?? { chain: m.chain, address: m.counterparty, usd: 0 };
      e.usd += usd;
      sentTo.set(key, e);
    }
    const candidates = [...sentTo.values()].sort((a, b) => b.usd - a.usd).slice(0, MAX_DEPOSIT_ADDRESS_CHECKS);

    const detected = new Map<string, string>();
    for (const c of candidates) {
      const identity = addressIdentity(c.chain, c.address);
      if (detected.has(identity)) continue;
      try {
        const exchange = sweepTarget(await evm.fetchRecentRecipients(c.chain, c.address));
        if (exchange) detected.set(identity, exchange);
      } catch (err) {
        this.logger.debug(`Deposit-address check failed for ${c.address} on ${c.chain}: ${(err as Error).message}`);
      }
    }
    return detected;
  }

  /** Prefer our own collection names; ask Alchemy for EVM contracts we don't track. */
  private async enrichNftNames(assets: Map<string, LedgerAsset>, alchemyKey: string | undefined) {
    const nfts = [...assets.values()].filter((a) => a.kind === 'nft');
    if (nfts.length === 0) return;
    const named = new Set<LedgerAsset>();
    const byChain = new Map<string, LedgerAsset[]>();
    for (const a of nfts) byChain.set(a.chain, [...(byChain.get(a.chain) ?? []), a]);

    for (const [chain, list] of byChain) {
      const lower = list.map((a) => (chain === 'solana' ? a.contract : a.contract.toLowerCase()));
      try {
        const rows = await this.db
          .select({ contractAddress: collections.contractAddress, name: collections.name })
          .from(collections)
          .where(
            and(
              sql`${collections.chain} = ${chain}`,
              chain === 'solana'
                ? inArray(collections.contractAddress, lower)
                : inArray(sql`lower(${collections.contractAddress})`, lower),
            ),
          );
        const names = new Map(rows.map((r) => [chain === 'solana' ? r.contractAddress : r.contractAddress.toLowerCase(), r.name]));
        for (const a of list) {
          const name = names.get(chain === 'solana' ? a.contract : a.contract.toLowerCase());
          if (name) {
            a.name = name;
            named.add(a);
          }
        }
      } catch (err) {
        this.logger.warn(`Collection name lookup failed on ${chain}: ${(err as Error).message}`);
      }

      if (chain !== 'solana' && alchemyKey) {
        const unnamed = list.filter((a) => !named.has(a));
        if (unnamed.length === 0) continue;
        const names = await new EvmActivityFetcher(alchemyKey).fetchContractNames(chain, unnamed.map((a) => a.contract));
        for (const a of unnamed) {
          const name = names.get(a.contract.toLowerCase());
          if (name) a.name = name;
        }
      }
    }
  }

  private async buildPricer(movements: LedgerMovement[], fees: LedgerFee[]): Promise<UsdPricer> {
    const symbols = new Set<string>();
    let earliest: Date | null = null;
    for (const m of movements) {
      if (m.asset.price?.kind === 'native') symbols.add(m.asset.price.symbol);
      if (!earliest || m.timestamp < earliest) earliest = m.timestamp;
    }
    for (const f of fees) {
      symbols.add(f.symbol);
      if (!earliest || f.timestamp < earliest) earliest = f.timestamp;
    }

    const now = new Date();
    const rates = new Map<string, { days: string[]; byDay: Map<string, number> }>();
    for (const symbol of symbols) {
      const chain = PRICED_SYMBOLS[symbol];
      if (!chain || !earliest) continue;
      const token = nativeTokenForChain(chain);
      const byDay = await this.priceOracle.getDailyUsdRates(token, earliest, now);
      // CoinGecko's free tier only serves the last 365 days; if the full-range
      // request came back empty, at least cover the recent year.
      const yearAgo = new Date(now.getTime() - 364 * 86_400_000);
      if (!byDay.has(toDayKey(new Date(now.getTime() - 2 * 86_400_000))) && earliest < yearAgo) {
        const recent = await this.priceOracle.getDailyUsdRates(token, yearAgo, now);
        for (const [d, p] of recent) byDay.set(d, p);
      }
      rates.set(symbol, { days: [...byDay.keys()].sort(), byDay });
    }

    return {
      usdPerUnit(ref: PriceRef, day: string): number | null {
        if (ref.kind === 'usd') return 1;
        const r = rates.get(ref.symbol);
        if (!r || r.days.length === 0) return null;
        const exact = r.byDay.get(day);
        if (exact !== undefined) return exact;
        const nearest = nearestDay(r.days, day);
        if (!nearest || Math.abs(daysBetween(nearest, day)) > MAX_PRICE_GAP_DAYS) return null;
        return r.byDay.get(nearest) ?? null;
      },
    };
  }
}

/**
 * The exchange an address sweeps into, if at least half of its recent sends go
 * to that exchange's wallets. Deposit addresses forward nearly everything; a
 * friend who once sent to Binance does not qualify.
 */
export function sweepTarget(recipients: string[]): string | null {
  if (recipients.length === 0) return null;
  const counts = new Map<string, number>();
  for (const r of recipients) {
    const exchange = EVM_EXCHANGE_WALLETS.get(r.toLowerCase());
    if (exchange) counts.set(exchange, (counts.get(exchange) ?? 0) + 1);
  }
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return best && best[1] * 2 >= recipients.length ? best[0] : null;
}

/** Binary search a sorted 'YYYY-MM-DD' list for the closest entry to `day`. */
export function nearestDay(days: string[], day: string): string | null {
  if (days.length === 0) return null;
  let lo = 0;
  let hi = days.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] < day) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [days[lo], days[lo - 1]].filter((d): d is string => d !== undefined);
  return candidates.sort((a, b) => Math.abs(daysBetween(a, day)) - Math.abs(daysBetween(b, day)))[0];
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}
