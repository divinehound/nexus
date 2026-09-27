import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { collections, wallets, type Database } from '@nexus/database';
import type { CashflowReport, CashflowResponse, CashflowWalletCoverage } from '@nexus/types';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { PriceOracleService, nativeTokenForChain, toDayKey } from '../admin/price-oracle.service';
import { buildCashflowReport, type LedgerAsset, type LedgerFee, type LedgerMovement, type UsdPricer } from './cashflow-ledger';
import { EVM_CHAINS, EvmActivityFetcher, shortAddress, type ChainFetchResult } from './evm-activity.fetcher';
import { SolanaActivityFetcher } from './solana-activity.fetcher';
import type { PriceRef } from './base-assets';

/** Chain whose native coin (per PriceOracleService) prices each money symbol. */
const PRICED_SYMBOLS: Record<string, string> = { ETH: 'ethereum', POL: 'polygon', APE: 'apechain', SOL: 'solana' };

/** A daily rate this many days away is still a reasonable stand-in for a missing day. */
const MAX_PRICE_GAP_DAYS = 7;
const MAX_CACHED_USERS = 200;

interface Entry {
  status: 'computing' | 'ready' | 'failed';
  startedAt: Date;
  progress: string;
  report: CashflowReport | null;
  error: string | null;
  walletsSignature: string;
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
    };
    this.remember(userId, next);
    const targets = linked.map((w) => ({ chain: w.chain as string, address: w.address }));
    this.compute(targets, next)
      .then((report) => {
        next.report = report;
        next.status = 'ready';
      })
      .catch((err: Error) => {
        this.logger.error(`Cash-flow report failed for user ${userId}: ${err.message}`, err.stack);
        next.status = 'failed';
        next.error = err.message;
      });
    return this.toResponse(next);
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

  private async compute(linked: Array<{ chain: string; address: string }>, entry: Entry): Promise<CashflowReport> {
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
        this.logger.warn(`Cash-flow scan failed for ${job.chain} ${job.address}: ${message}`);
        coverage.push({ chain: job.chain, address: job.address, transfers: 0, truncated: false, error: message });
      }
    }

    entry.progress = 'Looking up collection names…';
    await this.enrichNftNames(assets, alchemyKey);

    entry.progress = 'Pricing transactions…';
    const pricer = await this.buildPricer(movements, fees);

    entry.progress = 'Crunching numbers…';
    if (coverage.some((c) => c.truncated)) {
      notes.push('Some very active wallets hit the scan limit; the oldest history beyond it is not included.');
    }
    notes.push(
      'NFT and token values come from what you paid or received in ETH/SOL/POL/APE, their wrapped versions, or stablecoins in the same transaction.',
    );
    if (evmAddresses.length > 0 && alchemyKey) {
      notes.push('On Base, Abstract and ApeChain, sale proceeds paid out by a contract in native ETH/APE cannot be traced yet; WETH/stablecoin proceeds are.');
    }

    const report = buildCashflowReport({
      movements,
      fees,
      wallets: linked.map((w) => ({ chain: w.chain, address: w.address })),
      pricer,
      coverage,
      notes,
      now: new Date(),
    });
    if (report.totals.unpricedMovements > 0) {
      report.notes.push(
        `${report.totals.unpricedMovements} movements had no USD price for their day and count as $0 (historical prices older than a year need a paid CoinGecko key).`,
      );
    }
    return report;
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
