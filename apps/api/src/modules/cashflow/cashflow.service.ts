import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  cashflowAddressTags,
  cashflowFlags,
  cashflowScanState,
  cashflowScans,
  cashflowTxLinks,
  cashflowWalletChains,
  collections,
  wallets,
  watchedWallets,
  type Database,
} from '@nexus/database';
import type {
  CashflowAddressTag,
  CashflowExchangeSource,
  CashflowReport,
  CashflowResponse,
  CashflowTxLink,
  CashflowWalletChains,
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
import {
  EVM_CHAINS,
  EvmActivityFetcher,
  shortAddress,
} from './evm-activity.fetcher';
import { EVM_EXCHANGE_WALLETS, EXCHANGE_NAMES } from './exchange-wallets';
import { RELAY_PAYEES, RelayLinksFetcher } from './relay-links.fetcher';
import { SolanaActivityFetcher } from './solana-activity.fetcher';
import type { PriceRef } from './base-assets';
import {
  failedScan,
  fromSaved,
  mergeNew,
  nftsHeld,
  replaceTxs,
  resumePoint,
  toSaved,
  type SavedChainScan,
} from './scan-store';

const CHAIN_NAMES: Record<string, string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  polygon: 'Polygon',
  abstract: 'Abstract',
  apechain: 'ApeChain',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  zora: 'Zora',
  blast: 'Blast',
  linea: 'Linea',
  robinhood: 'Robinhood Chain',
  solana: 'Solana',
};

/** Chain whose native coin (per PriceOracleService) prices each money symbol. */
const PRICED_SYMBOLS: Record<string, string> = {
  ETH: 'ethereum',
  POL: 'polygon',
  APE: 'apechain',
  SOL: 'solana',
};

/** A daily rate this many days away is still a reasonable stand-in for a missing day. */
const MAX_PRICE_GAP_DAYS = 7;
const MAX_CACHED_USERS = 200;
/** How many of the biggest send-to addresses get checked for being exchange deposit addresses. */
const MAX_DEPOSIT_ADDRESS_CHECKS = 25;

/** Everything fetched from chain/price providers — enough to rebuild the report without rescanning. */
interface ScanData {
  wallets: Array<{ chain: string; address: string; watchOnly?: boolean }>;
  movements: LedgerMovement[];
  fees: LedgerFee[];
  pricer: UsdPricer;
  coverage: CashflowWalletCoverage[];
  notes: string[];
  relayLinks: ExplicitLink[];
  /** Exchange deposit addresses spotted by where they sweep funds, keyed by addressIdentity. */
  detectedExchanges: Map<string, string>;
  walletChains: CashflowWalletChains[];
}

interface Entry {
  status: 'computing' | 'ready' | 'failed';
  startedAt: Date;
  progress: string;
  report: CashflowReport | null;
  error: string | null;
  /** The wallet+chain targets the scan covers (see targetSignature). */
  signature: string;
  /** cashflow_scan_state.data_version (ms) the scan was loaded at; a newer one means another instance changed the data. */
  dataVersion: number;
  scan: ScanData | null;
}

/** One wallet on one chain — the unit that is scanned, saved and refreshed. */
export interface ScanTarget {
  chain: string;
  /** EVM addresses lowercased; Solana as-is. */
  address: string;
}

/** 'full' re-reads a target's whole history; 'new' only what happened since its last scan. */
export type ScanMode = 'full' | 'new';

/** Narrows the report to one wallet and/or one chain. */
export interface ReportView {
  wallet?: string;
  chain?: string;
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

export interface FlagInput {
  chain: string;
  txHash: string;
  note?: string;
}

export const ALL_CHAINS = [...EVM_CHAINS, 'solana'];
/** A scan whose instance hasn't checked in for this long is treated as abandoned (e.g. a deploy restarted it). */
const HEARTBEAT_STALE_MS = 90_000;
const HEARTBEAT_EVERY_MS = 20_000;

export function targetKey(t: ScanTarget): string {
  return `${t.chain}:${t.address}`;
}

export function targetSignature(targets: ScanTarget[]): string {
  return targets.map(targetKey).sort().join('|');
}

/**
 * Builds the per-user cash-flow report. Scans are saved per wallet+chain, so
 * loading the page rebuilds the report from saved data and only scans
 * wallets/chains that have never been scanned. Scanning full history can take
 * minutes, so it runs in the background and the endpoint is polled.
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

  /**
   * @param refresh Rescan every wallet and chain.
   * @param view Optional linked address and/or chain to report on alone (moves
   *   to the user's other wallets still count as own-wallet transfers).
   */
  async getReport(userId: string, refresh: boolean, v: ReportView = {}): Promise<CashflowResponse> {
    const linked = await this.linkedWallets(userId, v);
    if (linked.length === 0) return { status: 'no_wallets' };
    if (refresh) return this.refresh(userId, undefined, v);

    const entry = this.entries.get(userId);
    if (entry?.status === 'computing') return this.toResponse(entry);
    const state = await this.readState(userId);
    if (state && remoteScanActive(state)) return remoteComputing(state, entry);

    const { targets, walletChains } = await this.targetsFor(userId, linked);
    const signature = targetSignature(targets);
    const version = state?.dataVersion.getTime() ?? 0;
    if (entry && entry.signature === signature && entry.dataVersion === version) {
      if (entry.status === 'ready') return this.forView(userId, entry, v);
      if (entry.status === 'failed') return this.toResponse(entry);
    }

    return this.startJob(userId, signature, entry, v, async (job) => {
      const saved = await this.savedTargets(userId);
      const missing = targets.filter((t) => !saved.has(targetKey(t)));
      if (missing.length > 0) await this.scanTargets(missing, userId, job);
      return { scan: await this.load(userId, linked, targets, walletChains, job, missing), changed: missing.length > 0 };
    });
  }

  /**
   * Rescan some wallets/chains (all when `only` is omitted) and keep the rest
   * of the saved data as it is.
   */
  async refresh(
    userId: string,
    only: ScanTarget[] | undefined,
    view: ReportView = {},
    /** 'full' re-reads each target's whole history; 'new' only what happened since its last scan. */
    mode: ScanMode = 'full',
  ): Promise<CashflowResponse> {
    const linked = await this.linkedWallets(userId, view);
    if (linked.length === 0) return { status: 'no_wallets' };
    const entry = this.entries.get(userId);
    if (entry?.status === 'computing') return this.toResponse(entry);
    const state = await this.readState(userId);
    if (state && remoteScanActive(state)) return remoteComputing(state, entry);

    const { targets, walletChains } = await this.targetsFor(userId, linked);
    const wanted = only ? new Set(only.map((t) => targetKey(normalizeTarget(t)))) : null;
    const selected = wanted ? targets.filter((t) => wanted.has(targetKey(t))) : targets;
    if (selected.length === 0) throw new BadRequestException('None of those wallets/chains are scanned for your account');

    return this.startJob(userId, targetSignature(targets), entry, view, async (job) => {
      await this.scanTargets(selected, userId, job, mode);
      // Chains never scanned before come along too, so the report is complete.
      const saved = await this.savedTargets(userId);
      const missing = targets.filter((t) => !saved.has(targetKey(t)));
      if (missing.length > 0) await this.scanTargets(missing, userId, job);
      return { scan: await this.load(userId, linked, targets, walletChains, job, [...selected, ...missing]), changed: true };
    });
  }

  /**
   * Re-read just the flagged transactions from the chain and swap them into the
   * saved scans — for checking a fix without rescanning whole wallets.
   */
  async reimportFlags(userId: string, view: ReportView = {}): Promise<CashflowResponse> {
    const linked = await this.linkedWallets(userId, view);
    if (linked.length === 0) return { status: 'no_wallets' };
    const entry = this.entries.get(userId);
    if (entry?.status === 'computing') return this.toResponse(entry);
    const state = await this.readState(userId);
    if (state && remoteScanActive(state)) return remoteComputing(state, entry);
    const flags = await this.db.select().from(cashflowFlags).where(eq(cashflowFlags.userId, userId));
    if (flags.length === 0) throw new BadRequestException('Nothing is flagged');

    const { targets, walletChains } = await this.targetsFor(userId, linked);
    return this.startJob(userId, targetSignature(targets), entry, view, async (job) => {
      const failures = await this.reimport(userId, flags, targets, job);
      const scan = await this.load(userId, linked, targets, walletChains, job, []);
      scan.notes.push(...failures);
      return { scan, changed: true };
    });
  }

  /**
   * Re-run the (fast, pure) ledger over the last scan with the user's current
   * links, tags and flags — no chain calls. Falls back to a normal load if
   * nothing has been loaded yet.
   */
  async rebuild(userId: string, v: ReportView = {}): Promise<CashflowResponse> {
    const entry = this.entries.get(userId);
    if (!entry?.scan || entry.status === 'computing') return this.getReport(userId, false, v);
    entry.report = await this.buildFromScan(userId, entry.scan);
    entry.status = 'ready';
    return this.forView(userId, entry, v);
  }

  /** The cached all-wallets report, or one rebuilt from the same scan for a wallet/chain view. */
  private async forView(userId: string, entry: Entry, view: ReportView): Promise<CashflowResponse> {
    if ((!view.wallet && !view.chain) || entry.status !== 'ready' || !entry.scan) return this.toResponse(entry);
    return { status: 'ready', report: await this.buildFromScan(userId, entry.scan, view) };
  }

  /** Verified wallets plus watch-only ones (added without signing) — all count as the user's own. */
  private async linkedWallets(userId: string, view: ReportView) {
    const [verified, watched] = await Promise.all([
      this.db.query.wallets.findMany({ where: eq(wallets.userId, userId) }),
      this.db.query.watchedWallets.findMany({ where: eq(watchedWallets.userId, userId) }),
    ]);
    const linked: Array<{ chain: string; address: string; watchOnly?: boolean }> = verified.map((w) => ({
      chain: w.chain as string,
      address: w.address,
    }));
    for (const w of watched) {
      if (linked.some((l) => (l.chain === 'solana') === (w.family === 'solana') && sameWallet(l.address, w.address))) continue;
      linked.push({ chain: w.family === 'solana' ? 'solana' : 'ethereum', address: w.address, watchOnly: true });
    }
    if (view.wallet && !linked.some((w) => sameWallet(w.address, view.wallet!))) {
      throw new BadRequestException('That wallet is not linked to your account');
    }
    if (view.chain && !ALL_CHAINS.includes(view.chain)) throw new BadRequestException('Unknown chain');
    return linked;
  }

  /** Every wallet+chain to scan: each EVM address on its chosen chains (default: all), each Solana address. */
  private async targetsFor(
    userId: string,
    linked: Array<{ chain: string; address: string }>,
  ): Promise<{ targets: ScanTarget[]; walletChains: CashflowWalletChains[] }> {
    const settings = await this.db
      .select()
      .from(cashflowWalletChains)
      .where(eq(cashflowWalletChains.userId, userId));
    const chosen = new Map(settings.map((r) => [r.address.toLowerCase(), r.chains]));
    const targets: ScanTarget[] = [];
    const walletChains: CashflowWalletChains[] = [];
    const seen = new Set<string>();
    for (const w of linked) {
      const t = normalizeTarget(w);
      if (seen.has(t.address)) continue;
      seen.add(t.address);
      if (w.chain === 'solana') {
        targets.push(t);
        walletChains.push({ address: t.address, family: 'solana', chains: ['solana'], custom: false });
        continue;
      }
      const custom = chosen.get(t.address)?.filter((c) => EVM_CHAINS.includes(c));
      const chains = custom && custom.length > 0 ? custom : EVM_CHAINS;
      for (const chain of chains) targets.push({ chain, address: t.address });
      walletChains.push({ address: t.address, family: 'evm', chains, custom: !!custom?.length });
    }
    return { targets, walletChains };
  }

  /**
   * Run `work` in the background as the user's current job, sharing its
   * progress through cashflow_scan_state so other API instances report it too.
   */
  private startJob(
    userId: string,
    signature: string,
    previous: Entry | undefined,
    view: ReportView,
    work: (job: Entry) => Promise<{ scan: ScanData; changed: boolean }>,
  ): Promise<CashflowResponse> {
    const next: Entry = {
      status: 'computing',
      startedAt: new Date(),
      progress: 'Loading saved scans…',
      report: previous?.report ?? null,
      error: null,
      signature,
      dataVersion: previous?.dataVersion ?? 0,
      scan: null,
    };
    this.remember(userId, next);
    const beat = () =>
      this.writeState(userId, { status: 'scanning', progress: next.progress, heartbeatAt: new Date() }).catch(
        (err: Error) => this.logger.debug(`Scan heartbeat failed: ${err.message}`),
      );
    const heartbeat = setInterval(() => void beat(), HEARTBEAT_EVERY_MS);
    void this.writeState(userId, {
      status: 'scanning',
      progress: next.progress,
      error: null,
      startedAt: next.startedAt,
      heartbeatAt: next.startedAt,
    })
      .then(() => work(next))
      .then(async ({ scan, changed }) => {
        next.scan = scan;
        next.progress = 'Crunching numbers…';
        next.report = await this.buildFromScan(userId, scan);
        const version = changed ? new Date() : ((await this.readState(userId))?.dataVersion ?? new Date(0));
        await this.writeState(userId, { status: 'idle', progress: null, ...(changed ? { dataVersion: version } : {}) });
        next.dataVersion = version.getTime();
        next.status = 'ready';
      })
      .catch(async (err: Error) => {
        this.logger.error(`Cash-flow report failed for user ${userId}: ${err.message}`, err.stack);
        next.status = 'failed';
        next.error = err.message;
        await this.writeState(userId, { status: 'failed', error: err.message.slice(0, 1000) }).catch(() => undefined);
      })
      .finally(() => clearInterval(heartbeat));
    return Promise.resolve(this.toResponse(next));
  }

  private async readState(userId: string) {
    const [row] = await this.db.select().from(cashflowScanState).where(eq(cashflowScanState.userId, userId));
    return row ?? null;
  }

  private async writeState(userId: string, fields: Partial<typeof cashflowScanState.$inferInsert>) {
    await this.db
      .insert(cashflowScanState)
      .values({ userId, status: 'idle', ...fields })
      .onConflictDoUpdate({ target: cashflowScanState.userId, set: fields });
  }

  private async savedTargets(userId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ chain: cashflowScans.chain, address: cashflowScans.address })
      .from(cashflowScans)
      .where(and(eq(cashflowScans.userId, userId), eq(cashflowScans.kind, 'activity')));
    return new Set(rows.map((r) => targetKey(r)));
  }

  private async saveRow(userId: string, kind: string, chain: string, address: string, data: unknown) {
    await this.db
      .insert(cashflowScans)
      .values({ userId, kind, chain, address, data, scannedAt: new Date() })
      .onConflictDoUpdate({
        target: [cashflowScans.userId, cashflowScans.kind, cashflowScans.chain, cashflowScans.address],
        set: { data, scannedAt: new Date() },
      });
  }

  // ── User overrides ──

  /** Choose which EVM chains are scanned for one of the user's EVM addresses. */
  async setWalletChains(userId: string, address: string, chains: string[], view: ReportView = {}): Promise<CashflowResponse> {
    const linked = await this.linkedWallets(userId, view);
    const target = linked.find((w) => w.chain !== 'solana' && sameWallet(w.address, address));
    if (!target) throw new BadRequestException('That EVM wallet is not linked to your account');
    const entry = this.entries.get(userId);
    const state = await this.readState(userId);
    if (entry?.status === 'computing' || (state && remoteScanActive(state)))
      throw new BadRequestException('A scan is running — change chains once it finishes');

    const addr = address.toLowerCase();
    const picked = EVM_CHAINS.filter((c) => chains.includes(c));
    if (picked.length === 0) throw new BadRequestException('Pick at least one chain');
    if (picked.length === EVM_CHAINS.length) {
      await this.db
        .delete(cashflowWalletChains)
        .where(and(eq(cashflowWalletChains.userId, userId), eq(cashflowWalletChains.address, addr)));
    } else {
      await this.db
        .insert(cashflowWalletChains)
        .values({ userId, address: addr, chains: picked })
        .onConflictDoUpdate({
          target: [cashflowWalletChains.userId, cashflowWalletChains.address],
          set: { chains: picked },
        });
    }
    // Drop saved scans of chains no longer wanted; newly picked ones get scanned on the next load.
    const dropped = EVM_CHAINS.filter((c) => !picked.includes(c));
    if (dropped.length > 0) {
      await this.db
        .delete(cashflowScans)
        .where(
          and(
            eq(cashflowScans.userId, userId),
            eq(cashflowScans.kind, 'activity'),
            eq(cashflowScans.address, addr),
            inArray(cashflowScans.chain, dropped),
          ),
        );
    }
    await this.writeState(userId, { dataVersion: new Date() });
    return this.getReport(userId, false, view);
  }

  async addFlag(userId: string, input: FlagInput, view: ReportView = {}): Promise<CashflowResponse> {
    const txHash = input.chain === 'solana' ? input.txHash : input.txHash.toLowerCase();
    const note = input.note?.trim() || null;
    await this.db
      .insert(cashflowFlags)
      .values({ userId, chain: input.chain, txHash, note })
      .onConflictDoUpdate({
        target: [cashflowFlags.userId, cashflowFlags.chain, cashflowFlags.txHash],
        set: { note },
      });
    return this.rebuild(userId, view);
  }

  async removeFlag(userId: string, id: string, view: ReportView = {}): Promise<CashflowResponse> {
    await this.db.delete(cashflowFlags).where(and(eq(cashflowFlags.userId, userId), eq(cashflowFlags.id, id)));
    return this.rebuild(userId, view);
  }

  async addLink(userId: string, input: TxLinkInput, view: ReportView = {}): Promise<CashflowResponse> {
    const pair = normalizePair(input);
    // Linking and rejecting the same pair are mutually exclusive; the latest word wins.
    await this.db.delete(cashflowTxLinks).where(samePairCondition(userId, pair));
    // A tx may be in several links: one payment linked to NFTs sent in several txs is one trade.
    await this.db
      .insert(cashflowTxLinks)
      .values({ userId, kind: input.kind, ...pair })
      .onConflictDoNothing();
    return this.rebuild(userId, view);
  }

  async removeLink(userId: string, id: string, view: ReportView = {}): Promise<CashflowResponse> {
    await this.db
      .delete(cashflowTxLinks)
      .where(and(eq(cashflowTxLinks.userId, userId), eq(cashflowTxLinks.id, id)));
    return this.rebuild(userId, view);
  }

  async addAddressTag(userId: string, input: AddressTagInput, view: ReportView = {}): Promise<CashflowResponse> {
    const chainFamily = input.chain === 'solana' ? 'solana' : 'evm';
    const address = chainFamily === 'evm' ? input.address.toLowerCase() : input.address;
    await this.db
      .insert(cashflowAddressTags)
      .values({ userId, chainFamily, address, exchange: input.exchange })
      .onConflictDoUpdate({
        target: [
          cashflowAddressTags.userId,
          cashflowAddressTags.chainFamily,
          cashflowAddressTags.address,
        ],
        set: { exchange: input.exchange },
      });
    return this.rebuild(userId, view);
  }

  async removeAddressTag(userId: string, id: string, view: ReportView = {}): Promise<CashflowResponse> {
    await this.db
      .delete(cashflowAddressTags)
      .where(and(eq(cashflowAddressTags.userId, userId), eq(cashflowAddressTags.id, id)));
    return this.rebuild(userId, view);
  }

  private async buildFromScan(userId: string, scan: ScanData, view: ReportView = {}): Promise<CashflowReport> {
    const { wallet, chain } = view;
    const [linkRows, tagRows, flagRows] = await Promise.all([
      this.db.select().from(cashflowTxLinks).where(eq(cashflowTxLinks.userId, userId)),
      this.db.select().from(cashflowAddressTags).where(eq(cashflowAddressTags.userId, userId)),
      this.db.select().from(cashflowFlags).where(eq(cashflowFlags.userId, userId)),
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
      ...scan.relayLinks.filter(
        (l) =>
          !rejectedKeys.has(`${txKey(l.fromChain, l.fromTxHash)}>${txKey(l.toChain, l.toTxHash)}`),
      ),
    ];

    // Tagged beats detected beats the public list.
    const exchangeAddresses = new Map<
      string,
      { exchange: string; source: CashflowExchangeSource }
    >();
    for (const [address, exchange] of EVM_EXCHANGE_WALLETS)
      exchangeAddresses.set(`evm:${address}`, { exchange, source: 'known' });
    for (const [identity, exchange] of scan.detectedExchanges)
      exchangeAddresses.set(identity, { exchange, source: 'detected' });
    for (const t of addressTags) {
      exchangeAddresses.set(
        addressIdentity(t.chainFamily === 'solana' ? 'solana' : 'ethereum', t.address),
        { exchange: t.exchange, source: 'tagged' },
      );
    }

    const mine = (address: string) => !wallet || sameWallet(address, wallet);
    const report = buildCashflowReport({
      movements: scan.movements.filter((m) => mine(m.wallet)),
      fees: scan.fees.filter((f) => mine(f.wallet)),
      // All linked wallets stay "own", so moves to the others aren't counted as spending.
      wallets: scan.wallets,
      pricer: scan.pricer,
      coverage: scan.coverage.filter((c) => mine(c.address) && (!chain || c.chain === chain)),
      notes: [...scan.notes],
      now: new Date(),
      explicitLinks,
      rejectedLinks: rejected,
      exchangeAddresses,
      chainScope: chain ? (c) => c === chain : undefined,
      crossChainPayees: new Set(RELAY_PAYEES.map((p) => addressIdentity(p.chain, p.address))),
    });
    if (report.totals.unpricedMovements > 0) {
      report.notes.push(
        `${report.totals.unpricedMovements} movements had no USD price for their day (neither CoinGecko nor Coinbase had one). They're still counted in ETH/SOL/etc.; only their USD value is left out.`,
      );
    }
    report.walletFilter = wallet ?? null;
    report.chainFilter = chain ?? null;
    report.walletChains = scan.walletChains;
    report.availableChains = EVM_CHAINS;
    report.scans = scan.coverage;
    report.flags = flagRows.map((r) => ({
      id: r.id,
      chain: r.chain,
      txHash: r.txHash,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      reimportedAt: r.reimportedAt?.toISOString() ?? null,
    }));
    report.links = links;
    report.addressTags = addressTags;
    report.exchangeNames = EXCHANGE_NAMES;
    return report;
  }

  private toResponse(entry: Entry): CashflowResponse {
    if (entry.status === 'ready' && entry.report) return { status: 'ready', report: entry.report };
    if (entry.status === 'failed')
      return { status: 'failed', error: entry.error ?? 'Unknown error', previous: entry.report };
    return {
      status: 'computing',
      startedAt: entry.startedAt.toISOString(),
      progress: entry.progress,
      previous: entry.report,
    };
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

  private apiKeys() {
    return {
      alchemyKey: this.config.get<string>('alchemy.apiKey') || undefined,
      heliusKey:
        this.config.get<string>('helius.apiKey') || this.config.get<string>('HELIUS_API_KEY') || undefined,
      relayKey: this.config.get<string>('relay.apiKey') || undefined,
    };
  }

  /**
   * Scan each target and save it as soon as it's done, so a scan cut short
   * (e.g. by a deploy) keeps what it finished. Relay records for the scanned
   * addresses are refreshed too.
   */
  private async scanTargets(
    targets: ScanTarget[],
    userId: string,
    job: Entry,
    mode: ScanMode = 'full',
  ): Promise<void> {
    const { alchemyKey, heliusKey, relayKey } = this.apiKeys();
    const evm = alchemyKey ? new EvmActivityFetcher(alchemyKey) : null;
    const sol = heliusKey ? new SolanaActivityFetcher(heliusKey) : null;
    const previous =
      mode === 'new'
        ? await this.db
            .select()
            .from(cashflowScans)
            .where(and(eq(cashflowScans.userId, userId), eq(cashflowScans.kind, 'activity')))
        : [];
    for (const [i, t] of targets.entries()) {
      const isSol = t.chain === 'solana';
      if (isSol ? !sol : !evm) continue; // the missing key is noted when the report loads
      const prior = previous.find((r) => r.chain === t.chain && r.address === t.address)?.data as
        | SavedChainScan
        | undefined;
      // "Fetch new" needs to know where the last read stopped; without that, read it all.
      const since = prior ? resumePoint(prior, t.chain) : null;
      const label = `${CHAIN_NAMES[t.chain] ?? t.chain} ${shortAddress(t.address)} (${i + 1}/${targets.length})`;
      job.progress = since ? `Fetching new activity: ${label}` : `Scanning ${label}`;
      const assets = new Map<string, LedgerAsset>();
      let saved: SavedChainScan;
      try {
        let r;
        if (since && prior && isSol) {
          r = await sol!.fetch(t.address, assets, {
            // A minute's overlap: txs read twice are replaced, not duplicated.
            sinceTime: since.time! - 60,
            coreHeld: nftsHeld(prior, t.address),
          });
        } else if (since && prior) {
          r = await evm!.fetchSince(t.chain, t.address, since.block!, assets);
        } else {
          r = isSol ? await sol!.fetch(t.address, assets) : await evm!.fetch(t.chain, t.address, assets);
        }
        await this.enrichNftNames(assets, alchemyKey);
        saved = since && prior ? mergeNew(prior, r) : toSaved(r);
      } catch (err) {
        const message = (err as Error).message;
        // Networks have to be enabled per Alchemy app; one that isn't is a config gap, not a failure.
        const disabled = !isSol && /HTTP 403|not enabled|unsupported network/i.test(message);
        if (!disabled) this.logger.warn(`Cash-flow scan failed for ${t.chain} ${t.address}: ${message}`);
        if (since && prior) continue; // a failed "fetch new" keeps what was already saved
        saved = failedScan(message, disabled);
      }
      await this.saveRow(userId, 'activity', t.chain, t.address, saved);
    }

    if (relayKey) {
      const relay = new RelayLinksFetcher(relayKey);
      for (const address of new Set(targets.map((t) => t.address))) {
        job.progress = `Checking bridge records for ${shortAddress(address)}…`;
        try {
          await this.saveRow(userId, 'relay', '', address, { links: await relay.fetchLinks(address) });
        } catch (err) {
          // Keep the last good records; the note below says they may be stale.
          this.logger.warn(`Relay history lookup failed for ${address}: ${(err as Error).message}`);
          await this.saveRow(userId, 'relay_error', '', address, { message: (err as Error).message });
        }
      }
    }
  }

  /**
   * Assemble the report inputs from saved scans. When `rescanned` touched EVM
   * wallets, exchange deposit-address detection is re-run over the result.
   */
  private async load(
    userId: string,
    linked: Array<{ chain: string; address: string }>,
    targets: ScanTarget[],
    walletChains: CashflowWalletChains[],
    job: Entry,
    rescanned: ScanTarget[],
  ): Promise<ScanData> {
    job.progress = 'Loading saved scans…';
    const { alchemyKey, heliusKey, relayKey } = this.apiKeys();
    const rows = await this.db.select().from(cashflowScans).where(eq(cashflowScans.userId, userId));
    const wanted = new Set(targets.map(targetKey));
    const addresses = new Set(targets.map((t) => t.address));
    const assets = new Map<string, LedgerAsset>();
    const movements: LedgerMovement[] = [];
    const fees: LedgerFee[] = [];
    const coverage: CashflowWalletCoverage[] = [];
    const notes: string[] = [];
    const relayLinks: ExplicitLink[] = [];
    const relayFailed: string[] = [];
    let detectedExchanges = new Map<string, string>();
    // Oldest first, so a newer scan's asset names win.
    for (const row of [...rows].sort((a, b) => a.scannedAt.getTime() - b.scannedAt.getTime())) {
      if (row.kind === 'activity' && wanted.has(targetKey(row))) {
        const r = fromSaved(row.data as SavedChainScan, row.chain, row.address, row.scannedAt, assets);
        movements.push(...r.movements);
        fees.push(...r.fees);
        coverage.push(r.coverage);
        notes.push(...r.notes);
      } else if (row.kind === 'relay' && addresses.has(row.address)) {
        relayLinks.push(...((row.data as { links?: ExplicitLink[] }).links ?? []));
      } else if (row.kind === 'relay_error' && addresses.has(row.address)) {
        const ok = rows.find((r) => r.kind === 'relay' && r.address === row.address);
        if (!ok || ok.scannedAt < row.scannedAt) relayFailed.push(row.address);
      } else if (row.kind === 'deposits') {
        detectedExchanges = new Map((row.data as { detected?: Array<[string, string]> }).detected ?? []);
      }
    }

    const hasEvm = targets.some((t) => t.chain !== 'solana');
    const hasSol = targets.some((t) => t.chain === 'solana');
    if (hasEvm && !alchemyKey) notes.push('EVM wallets were skipped: ALCHEMY_API_KEY is not configured.');
    if (hasSol && !heliusKey) notes.push('Solana wallets were skipped: HELIUS_API_KEY is not configured.');
    const disabled = [...new Set(coverage.filter((c) => c.disabled).map((c) => c.chain))];
    if (disabled.length > 0) {
      notes.push(
        `Not scanned — enable these networks on the Alchemy app to include them (or untick them for your wallets): ${disabled.join(', ')}. Bridges to them will show as money out.`,
      );
    }
    if (coverage.some((c) => c.truncated)) {
      notes.push('Some very active wallets hit the scan limit; the oldest history beyond it is not included.');
    }
    notes.push(
      'NFT and token values come from what you paid or received in ETH/SOL/POL/APE, their wrapped versions, or stablecoins in the same transaction.',
    );
    if (hasEvm && alchemyKey) {
      notes.push(
        'Outside Ethereum and Polygon, NFT sale proceeds paid out by a contract in native ETH/APE are found from your balance change around the sale.',
      );
    }
    if (!relayKey) {
      notes.push(
        "Relay bridges are paired by amount and timing; set RELAY_API_KEY to pair them exactly from Relay's records.",
      );
    }
    for (const address of relayFailed) {
      notes.push(`Couldn't load Relay history for ${shortAddress(address)}; its bridges fall back to amount/timing matching.`);
    }

    job.progress = 'Pricing transactions…';
    const pricer = await this.buildPricer(movements, fees);

    if (alchemyKey && rescanned.some((t) => t.chain !== 'solana')) {
      job.progress = 'Checking which transfers went to exchanges…';
      const own = new Set(linked.map((w) => addressIdentity(w.chain, w.address)));
      detectedExchanges = await this.detectExchangeDepositAddresses(
        new EvmActivityFetcher(alchemyKey),
        movements,
        pricer,
        own,
      );
      await this.saveRow(userId, 'deposits', '', '', { detected: [...detectedExchanges] });
    }

    return {
      wallets: linked,
      movements,
      fees,
      pricer,
      coverage,
      notes,
      relayLinks,
      detectedExchanges,
      walletChains,
    };
  }

  /**
   * Refetch each flagged tx for every scanned wallet on its chain and swap it
   * into that wallet's saved scan. Returns notes for anything that failed.
   */
  private async reimport(
    userId: string,
    flags: Array<typeof cashflowFlags.$inferSelect>,
    targets: ScanTarget[],
    job: Entry,
  ): Promise<string[]> {
    const { alchemyKey, heliusKey } = this.apiKeys();
    const failures: string[] = [];
    const byChain = new Map<string, string[]>();
    for (const f of flags) byChain.set(f.chain, [...(byChain.get(f.chain) ?? []), f.txHash]);
    const rows = await this.db
      .select()
      .from(cashflowScans)
      .where(and(eq(cashflowScans.userId, userId), eq(cashflowScans.kind, 'activity')));

    const done: string[] = [];
    for (const [chain, hashes] of byChain) {
      const isSol = chain === 'solana';
      const key = isSol ? heliusKey : alchemyKey;
      const wallets = targets.filter((t) => t.chain === chain);
      if (!key || wallets.length === 0) {
        failures.push(
          `Flagged ${CHAIN_NAMES[chain] ?? chain} transactions weren't re-imported: none of your wallets are scanned on that chain.`,
        );
        continue;
      }
      let ok = true;
      for (const t of wallets) {
        const row = rows.find((r) => r.chain === chain && r.address === t.address);
        if (!row || (row.data as SavedChainScan).error) continue; // never scanned (or failed) — a full scan covers it
        job.progress = `Re-importing ${hashes.length} flagged ${CHAIN_NAMES[chain] ?? chain} transaction${hashes.length === 1 ? '' : 's'} for ${shortAddress(t.address)}…`;
        try {
          const assets = new Map<string, LedgerAsset>();
          const fresh = isSol
            ? await new SolanaActivityFetcher(key).fetchTxs(
                t.address,
                hashes,
                assets,
                nftsReceived(row.data as SavedChainScan, new Set(hashes)),
              )
            : await new EvmActivityFetcher(key).fetchTxs(chain, t.address, hashes, assets);
          await this.enrichNftNames(assets, alchemyKey);
          const hashSet = new Set(isSol ? hashes : hashes.map((h) => h.toLowerCase()));
          const next = replaceTxs(row.data as SavedChainScan, hashSet, fresh);
          // Keep scanned_at: this row's history wasn't rescanned, only these txs.
          await this.db.update(cashflowScans).set({ data: next }).where(eq(cashflowScans.id, row.id));
        } catch (err) {
          ok = false;
          this.logger.warn(`Re-import failed on ${chain} for ${t.address}: ${(err as Error).message}`);
          failures.push(
            `Re-importing flagged ${CHAIN_NAMES[chain] ?? chain} transactions failed for ${shortAddress(t.address)}: ${(err as Error).message.slice(0, 120)}`,
          );
        }
      }
      if (ok) done.push(...flags.filter((f) => f.chain === chain).map((f) => f.id));
    }
    if (done.length > 0) {
      await this.db
        .update(cashflowFlags)
        .set({ reimportedAt: new Date() })
        .where(and(eq(cashflowFlags.userId, userId), inArray(cashflowFlags.id, done)));
    }
    return failures;
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
    const txHasAsset = new Set(
      movements.filter((m) => !m.asset.price).map((m) => `${m.chain}:${m.txHash}`),
    );
    const sentTo = new Map<string, { chain: string; address: string; usd: number }>();
    for (const m of movements) {
      if (m.chain === 'solana' || m.direction !== 'out' || !m.asset.price || !m.counterparty)
        continue;
      if (txHasAsset.has(`${m.chain}:${m.txHash}`)) continue;
      const identity = addressIdentity(m.chain, m.counterparty);
      if (own.has(identity) || EVM_EXCHANGE_WALLETS.has(m.counterparty.toLowerCase())) continue;
      const usd = (pricer.usdPerUnit(m.asset.price, toDayKey(m.timestamp)) ?? 0) * m.amount;
      const key = `${identity}@${m.chain}`;
      const e = sentTo.get(key) ?? { chain: m.chain, address: m.counterparty, usd: 0 };
      e.usd += usd;
      sentTo.set(key, e);
    }
    const candidates = [...sentTo.values()]
      .sort((a, b) => b.usd - a.usd)
      .slice(0, MAX_DEPOSIT_ADDRESS_CHECKS);

    const detected = new Map<string, string>();
    for (const c of candidates) {
      const identity = addressIdentity(c.chain, c.address);
      if (detected.has(identity)) continue;
      try {
        const exchange = sweepTarget(await evm.fetchRecentRecipients(c.chain, c.address));
        if (exchange) detected.set(identity, exchange);
      } catch (err) {
        this.logger.debug(
          `Deposit-address check failed for ${c.address} on ${c.chain}: ${(err as Error).message}`,
        );
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
        const names = new Map(
          rows.map((r) => [
            chain === 'solana' ? r.contractAddress : r.contractAddress.toLowerCase(),
            r.name,
          ]),
        );
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
        const names = await new EvmActivityFetcher(alchemyKey).fetchContractNames(
          chain,
          unnamed.map((a) => a.contract),
        );
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
 * NFTs (by token id) the wallet received anywhere in a saved scan, outside the
 * given txs — so re-reading a marketplace-settled sale knows the NFT was the
 * wallet's to sell.
 */
export function nftsReceived(saved: SavedChainScan, except: Set<string>): Set<string> {
  const nft = new Set(saved.assets.filter((a) => a.kind === 'nft').map((a) => a.key));
  const held = new Set<string>();
  for (const m of saved.movements)
    if (m.d === 'in' && m.i && nft.has(m.a) && !except.has(m.h)) held.add(m.i);
  return held;
}

export function normalizeTarget(t: ScanTarget): ScanTarget {
  return { chain: t.chain, address: t.chain === 'solana' ? t.address : t.address.toLowerCase() };
}

type ScanStateRow = typeof cashflowScanState.$inferSelect;

/** Another API instance is scanning for this user and still checking in. */
export function remoteScanActive(state: ScanStateRow, now = Date.now()): boolean {
  return state.status === 'scanning' && now - state.heartbeatAt.getTime() < HEARTBEAT_STALE_MS;
}

function remoteComputing(state: ScanStateRow, entry: Entry | undefined): CashflowResponse {
  return {
    status: 'computing',
    startedAt: state.startedAt.toISOString(),
    progress: state.progress ?? 'Scanning…',
    previous: entry?.report ?? null,
  };
}

type TxPairFields = Pick<TxLinkInput, 'fromChain' | 'fromTxHash' | 'toChain' | 'toTxHash'>;

/** EVM tx hashes are case-insensitive hex; store them lowercased so pairs match however they were pasted. */
export function normalizePair(p: TxPairFields): TxPairFields {
  const norm = (chain: string, hash: string) => (chain === 'solana' ? hash : hash.toLowerCase());
  return {
    fromChain: p.fromChain,
    fromTxHash: norm(p.fromChain, p.fromTxHash),
    toChain: p.toChain,
    toTxHash: norm(p.toChain, p.toTxHash),
  };
}

const t = cashflowTxLinks;
const txIs = (chainCol: AnyPgColumn, hashCol: AnyPgColumn, chain: string, hash: string) =>
  and(eq(chainCol, chain), eq(hashCol, hash));

/**
 * This user's rows for the pair in either direction. Built with and()/or() —
 * never a raw "A OR B" fragment, which and() would not parenthesise and would
 * let the OR branch escape the user filter.
 */
export function samePairCondition(userId: string, p: TxPairFields): SQL {
  return and(
    eq(t.userId, userId),
    or(
      and(
        txIs(t.fromChain, t.fromTxHash, p.fromChain, p.fromTxHash),
        txIs(t.toChain, t.toTxHash, p.toChain, p.toTxHash),
      ),
      and(
        txIs(t.fromChain, t.fromTxHash, p.toChain, p.toTxHash),
        txIs(t.toChain, t.toTxHash, p.fromChain, p.fromTxHash),
      ),
    ),
  )!;
}

/** EVM addresses compare case-insensitively; Solana addresses are case-sensitive base58. */
export function sameWallet(a: string, b: string): boolean {
  return a.startsWith('0x') || b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b;
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
  return candidates.sort(
    (a, b) => Math.abs(daysBetween(a, day)) - Math.abs(daysBetween(b, day)),
  )[0];
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}
