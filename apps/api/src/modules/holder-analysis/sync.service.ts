// The holder analysis sync: read each followed collection's new transfers, then fill in what the
// analysis needs about the transactions and wallets, a budgeted slice per run, holders first.
// Everything is resumable: a run that runs out of calls (or hits a rate limit) leaves the rest
// for the next. Ported from the holder analysis Worker (spooky-bar apps/holder-analysis/src/
// sync.ts) onto Postgres; only projects with holder_analysis_enabled are followed.

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { CHAIN_META } from '@nexus/types';
import type { Database } from '@nexus/database';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  areContracts,
  type Budget,
  budgetFor,
  type ChainEnv,
  delegationsOf,
  ensNames,
  funderOf,
  headBlock,
  lastOutOf,
  left,
  openseaName,
  RateLimited,
  type RawTransfer,
  readTransfers,
  txDetails,
  usageOf,
} from './chain';
import { type AnalysisCollection, type AnalysisProject, loadEnabledProjects } from './projects';

/** Blocks behind the head we wait for, so a reorg doesn't leave a transfer that never happened. */
const CONFIRMATIONS = 3;
/** How often a holder's last outgoing activity is read again (it decides active / dormant). */
const REFRESH_DAYS = 7;
/** How often delegations and the wake-up outlook are read again. */
const RECHECK_DAYS = 30;
const DAY = 86_400_000;
const BURN = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (v: unknown) => JSON.stringify(v);
const msDate = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

export type SyncLog = {
  calls: number;
  transfers: number;
  txs: number;
  wallets: number;
  delegations: number;
  refreshed: number;
  names: number;
  usage: number;
  /** Collections whose transfers have caught up with the chain in this run. */
  caughtUp: string[];
  errors: string[];
};

export type SyncSettings = {
  runCalls: number;
  callGapMs: number;
  txBatch: number;
  openseaCalls: number;
  etherscanCalls: number;
};

@Injectable()
export class HolderAnalysisSyncService {
  private readonly logger = new Logger(HolderAnalysisSyncService.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  settings(): SyncSettings {
    const n = (key: string, d: number) => Number(this.config.get<number>(key) ?? d) || d;
    return {
      runCalls: n('holderAnalysis.runCalls', 300),
      callGapMs: n('holderAnalysis.callGapMs', 500),
      txBatch: n('holderAnalysis.txBatch', 10),
      openseaCalls: n('holderAnalysis.openseaCalls', 40),
      etherscanCalls: n('holderAnalysis.etherscanCalls', 100),
    };
  }

  /** How to reach a chain, or null when it isn't an Alchemy EVM chain or there's no key. */
  envFor(chain: string): ChainEnv | null {
    const meta = CHAIN_META[chain as keyof typeof CHAIN_META];
    const key = this.config.get<string>('alchemy.apiKey');
    if (!meta?.isEvm || !meta.alchemySubdomain || !meta.evmChainId || !key) return null;
    return {
      rpcUrl: `https://${meta.alchemySubdomain}.g.alchemy.com/v2/${key}`,
      chainId: meta.evmChainId,
      mainnet: chain === 'ethereum',
      openseaKey: this.config.get<string>('opensea.apiKey') || undefined,
      etherscanKey: this.config.get<string>('etherscan.apiKey') || undefined,
    };
  }

  /** One run: every step gets what's left of the budget, in order. */
  async runSync(projectsIn?: AnalysisProject[], budget?: Budget): Promise<SyncLog> {
    const s = this.settings();
    const b = budget ?? budgetFor(s.runCalls, s.callGapMs);
    const log: SyncLog = { calls: 0, transfers: 0, txs: 0, wallets: 0, delegations: 0, refreshed: 0, names: 0, usage: 0, caughtUp: [], errors: [] };
    const projects = projectsIn ?? (await loadEnabledProjects(this.db));
    if (!projects.length) return log;
    const collections = uniqueCollections(projects);
    const coreIds = collections.filter((c) => c.core).map((c) => c.collectionId);

    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        if (!(err instanceof RateLimited) && !String(err).includes('out of calls')) this.logger.error(`${name}: ${err instanceof Error ? err.stack : err}`);
        log.errors.push(`${name}: ${err instanceof Error ? err.message : err}`);
      }
    };
    await step('transfers', () => this.syncTransfers(b, log, collections));
    await step('transactions', () => this.fillTxs(b, log, s.txBatch));
    await step('delegations', () => this.fillDelegations(b, log, coreIds));
    await step('refresh', () => this.refreshLastOut(b, log, coreIds, Math.max(10, Math.floor(b.max / 5))));
    await step('wallets', () => this.fillWallets(b, log, coreIds));
    await step('names', () => this.fillNames(b, log, projects, s.openseaCalls));
    await step('usage', () => this.fillUsage(log, projects, s.etherscanCalls));
    log.calls = b.calls;
    if (b.limited && !log.errors.length) log.errors.push("Alchemy's rate limit: carrying on at the next run");
    return log;
  }

  private async syncTransfers(b: Budget, log: SyncLog, collections: AnalysisCollection[]) {
    const heads = new Map<string, number>();
    const cursors = new Map(
      [...(await this.db.execute<{ collection_id: string; last_block: number }>(sql`SELECT collection_id, last_block FROM collection_transfer_sync`))].map((r) => [
        r.collection_id,
        Number(r.last_block),
      ]),
    );
    for (const c of collections) {
      const env = this.envFor(c.chain);
      if (!env) continue;
      try {
        if (!heads.has(c.chain)) heads.set(c.chain, (await headBlock(env, b)) - CONFIRMATIONS);
        const head = heads.get(c.chain)!;
        let block = cursors.get(c.collectionId) ?? 0;
        while (block < head && left(b) > 2) {
          const { rows, through } = await readTransfers(env, b, c, block + 1, head);
          await this.storeTransfers(c, rows, through, through >= head);
          log.transfers += rows.length;
          block = through;
          if (through >= head) log.caughtUp.push(c.collectionId);
        }
      } catch (err) {
        await this.db.execute(sql`
          INSERT INTO collection_transfer_sync (collection_id, error, error_at) VALUES (${c.collectionId}, ${String(err instanceof Error ? err.message : err).slice(0, 300)}, now())
          ON CONFLICT (collection_id) DO UPDATE SET error = excluded.error, error_at = excluded.error_at`);
        if (err instanceof RateLimited) throw err;
      }
    }
  }

  /** One stretch of transfers, the wallets they bring (core collections) and the cursor, in one transaction. */
  async storeTransfers(c: AnalysisCollection, rows: RawTransfer[], through: number, live: boolean) {
    const nft = c.standard !== 'erc20';
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += 1000) {
        const part = rows.slice(i, i + 1000).map((r) => ({
          b: r.block,
          l: r.logIndex,
          at: new Date(r.at).toISOString(),
          h: r.tx,
          f: r.from,
          t: r.to,
          k: r.tokenId ?? '',
          a: r.amount,
        }));
        await tx.execute(sql`
          INSERT INTO collection_transfers (collection_id, chain, block_number, log_index, block_time, tx_hash, from_address, to_address, token_id, amount, need_tx)
          SELECT ${c.collectionId}::uuid, ${c.chain}::chain, j.b, j.l, j.at, j.h, j.f, j.t, j.k, j.a, ${nft}
          FROM jsonb_to_recordset(${json(part)}::jsonb) AS j(b bigint, l int, at timestamptz, h text, f text, t text, k text, a double precision)
          ON CONFLICT DO NOTHING`);
      }
      if (c.core) {
        const wallets = [...new Set(rows.flatMap((r) => [r.from, r.to]))].filter((w) => !BURN.has(w));
        for (let i = 0; i < wallets.length; i += 2000) {
          await tx.execute(sql`
            INSERT INTO wallet_profiles (chain, address)
            SELECT ${c.chain}::chain, w FROM jsonb_array_elements_text(${json(wallets.slice(i, i + 2000))}::jsonb) AS w
            ON CONFLICT DO NOTHING`);
        }
      }
      await tx.execute(sql`
        INSERT INTO collection_transfer_sync (collection_id, last_block, live, synced_at) VALUES (${c.collectionId}, ${through}, ${live}, now())
        ON CONFLICT (collection_id) DO UPDATE SET last_block = excluded.last_block, live = collection_transfer_sync.live OR excluded.live,
          synced_at = excluded.synced_at, error = NULL, error_at = NULL`);
    });
  }

  /** Sender, target and ETH value for NFT transfers' transactions: up to 60% of the run, so wallets move on too. */
  private async fillTxs(b: Budget, log: SyncLog, per: number) {
    const stop = b.calls + Math.ceil(b.max * 0.6);
    while (left(b) > 1 && b.calls < stop) {
      const pending = [...(await this.db.execute<{ chain: string; tx_hash: string }>(sql`
        SELECT DISTINCT chain::text AS chain, tx_hash FROM collection_transfers WHERE need_tx LIMIT ${per}`))];
      if (!pending.length) return;
      const chain = pending[0].chain;
      const env = this.envFor(chain);
      if (!env) return;
      const found = await txDetails(env, b, pending.filter((p) => p.chain === chain).map((p) => p.tx_hash));
      if (!found.size) return; // Alchemy dropped the whole batch: try again next run.
      const rows = [...found].map(([h, t]) => ({ h, f: t.from, t: t.to, v: t.value }));
      await this.db.execute(sql`
        UPDATE collection_transfers ct SET tx_from = j.f, tx_to = j.t, tx_value_wei = j.v::numeric, need_tx = false
        FROM jsonb_to_recordset(${json(rows)}::jsonb) AS j(h text, f text, t text, v text)
        WHERE ct.tx_hash = j.h AND ct.need_tx AND ct.chain = ${chain}::chain`);
      log.txs += found.size;
    }
  }

  /**
   * Wallets still worth reading: ones that received a token of a core collection of a project
   * that is turned on. Holders in a current report come first.
   */
  private followed(coreIds: string[]) {
    return sql`EXISTS (
      SELECT 1 FROM collection_transfers t
      WHERE t.to_address = w.address AND t.chain = w.chain
        AND t.collection_id IN (SELECT (jsonb_array_elements_text(${json(coreIds)}::jsonb))::uuid))`;
  }
  private readonly priority = sql`(EXISTS (SELECT 1 FROM holder_report_holders h WHERE h.address = w.address)) DESC`;

  /** Delegations (Ethereum only; re-read every RECHECK_DAYS), up to 30% of the run. */
  private async fillDelegations(b: Budget, log: SyncLog, coreIds: string[]) {
    const env = this.envFor('ethereum');
    if (!env || !coreIds.length) return;
    const stop = b.calls + Math.ceil(b.max * 0.3);
    while (left(b) > 1 && b.calls < stop) {
      const wallets = [...(await this.db.execute<{ address: string }>(sql`
        SELECT w.address FROM wallet_profiles w
        WHERE w.chain = 'ethereum' AND (w.delegations_at IS NULL OR w.delegations_at < ${msDate(Date.now() - RECHECK_DAYS * DAY)}) AND ${this.followed(coreIds)}
        ORDER BY w.delegations_at IS NOT NULL, ${this.priority} LIMIT 5`))].map((r) => r.address);
      if (!wallets.length) return;
      const found = await delegationsOf(env, b, wallets);
      const done = [...found].filter(([, d]) => d !== null).map(([a, d]) => ({ a, d }));
      if (!done.length) return;
      await this.db.execute(sql`
        UPDATE wallet_profiles w SET delegations = j.d, delegations_at = now()
        FROM jsonb_to_recordset(${json(done)}::jsonb) AS j(a text, d jsonb)
        WHERE w.chain = 'ethereum' AND w.address = j.a`);
      log.delegations += done.length;
    }
  }

  /** First pass per wallet: contract or not, first funder, last outgoing activity (2 calls + 1 per 100). */
  private async fillWallets(b: Budget, log: SyncLog, coreIds: string[]) {
    if (!coreIds.length) return;
    while (left(b) > 3) {
      const n = Math.min(50, Math.floor((left(b) - 1) / 2));
      const pending = [...(await this.db.execute<{ chain: string; address: string }>(sql`
        SELECT w.chain::text AS chain, w.address FROM wallet_profiles w
        WHERE w.info_at IS NULL AND ${this.followed(coreIds)}
        ORDER BY ${this.priority} LIMIT ${n}`))];
      if (!pending.length) return;
      const chain = pending[0].chain;
      const env = this.envFor(chain);
      if (!env) return;
      const wallets = pending.filter((p) => p.chain === chain).map((p) => p.address);
      const code = await areContracts(env, b, wallets);
      const rows: { a: string; c: boolean | null; f: string | null; fa: string | null; lo: string | null }[] = [];
      try {
        for (const w of wallets) {
          if (left(b) < 2) break;
          const f = await funderOf(env, b, w);
          const last = await lastOutOf(env, b, w);
          rows.push({ a: w, c: code.get(w) ?? null, f: f.funder, fa: msDate(f.fundedAt), lo: msDate(last) });
        }
      } finally {
        if (rows.length)
          await this.db.execute(sql`
            UPDATE wallet_profiles w SET is_contract = j.c, funder = j.f, funded_at = j.fa, last_out_at = j.lo, info_at = now()
            FROM jsonb_to_recordset(${json(rows)}::jsonb) AS j(a text, c boolean, f text, fa timestamptz, lo timestamptz)
            WHERE w.chain = ${chain}::chain AND w.address = j.a`);
        log.wallets += rows.length;
      }
    }
  }

  /** Holders' last outgoing activity read again every REFRESH_DAYS, up to `max` calls a run. */
  private async refreshLastOut(b: Budget, log: SyncLog, coreIds: string[], max: number) {
    if (!coreIds.length || left(b) < 2) return;
    const pending = [...(await this.db.execute<{ chain: string; address: string }>(sql`
      SELECT w.chain::text AS chain, w.address FROM wallet_profiles w
      WHERE w.info_at < ${msDate(Date.now() - REFRESH_DAYS * DAY)}
        AND EXISTS (SELECT 1 FROM holder_report_holders h WHERE h.address = w.address)
        AND ${this.followed(coreIds)}
      ORDER BY w.info_at LIMIT ${Math.min(max, left(b) - 1)}`))];
    const rows: { c: string; a: string; lo: string | null }[] = [];
    try {
      for (const { chain, address } of pending) {
        const env = this.envFor(chain);
        if (!env || left(b) < 2) break;
        rows.push({ c: chain, a: address, lo: msDate(await lastOutOf(env, b, address)) });
      }
    } finally {
      if (rows.length)
        await this.db.execute(sql`
          UPDATE wallet_profiles w SET last_out_at = COALESCE(j.lo, w.last_out_at), info_at = now()
          FROM jsonb_to_recordset(${json(rows)}::jsonb) AS j(c text, a text, lo timestamptz)
          WHERE w.chain::text = j.c AND w.address = j.a`);
      log.refreshed += rows.length;
    }
  }

  /** ENS names (Ethereum, one call per 100 wallets) and OpenSea usernames (openseaCalls a run) for current holders. */
  private async fillNames(b: Budget, log: SyncLog, projects: AnalysisProject[], openseaCalls: number) {
    const ids = projects.map((p) => p.id);
    const pending = [...(await this.db.execute<{ address: string }>(sql`
      SELECT DISTINCT x.address FROM (
        SELECT address, project_id FROM holder_report_holders UNION SELECT address, project_id FROM holder_report_side_holders
      ) x
      LEFT JOIN wallet_profiles w ON w.chain = 'ethereum' AND w.address = x.address
      WHERE x.project_id IN (SELECT (jsonb_array_elements_text(${json(ids)}::jsonb))::uuid) AND w.names_at IS NULL
      LIMIT 100`))].map((r) => r.address);
    const env = this.envFor('ethereum');
    if (!pending.length || !env || left(b) < 1) return;
    const ens = await ensNames(env, b, pending);
    if (b.limited) return;
    const opensea = new Map<string, string | null>();
    if (env.openseaKey)
      for (const w of pending.slice(0, openseaCalls)) {
        const name = await openseaName(env, w);
        if (name !== undefined) opensea.set(w, name);
        await sleep(300);
      }
    // ENS goes in for all; a wallet counts as named once OpenSea has answered too (when set up).
    const done = new Set(env.openseaKey ? pending.filter((w) => opensea.has(w)) : pending);
    const rows = pending.map((a) => ({ a, e: ens.get(a) ?? null, o: opensea.get(a) ?? null, n: done.has(a) ? new Date().toISOString() : null }));
    await this.db.execute(sql`
      INSERT INTO wallet_profiles (chain, address, ens, opensea, names_at)
      SELECT 'ethereum', j.a, j.e, j.o, j.n FROM jsonb_to_recordset(${json(rows)}::jsonb) AS j(a text, e text, o text, n timestamptz)
      ON CONFLICT (chain, address) DO UPDATE SET ens = COALESCE(excluded.ens, wallet_profiles.ens),
        opensea = COALESCE(excluded.opensea, wallet_profiles.opensea), names_at = COALESCE(excluded.names_at, wallet_profiles.names_at)`);
    log.names += done.size;
  }

  /** The wake-up outlook: each project's holders' transactions from Etherscan (3 a second), etherscanCalls a run. */
  private async fillUsage(log: SyncLog, projects: AnalysisProject[], etherscanCalls: number) {
    let calls = etherscanCalls;
    for (const project of projects) {
      if (calls <= 0) return;
      // Etherscan is asked on the project's main chain: its first core collection's.
      const chain = (project.collections.find((c) => c.core) ?? project.collections[0]).chain;
      const env = this.envFor(chain);
      if (!env?.etherscanKey) continue;
      const contracts = new Set([...project.collections.map((c) => c.contract), ...project.collections.flatMap((c) => c.staking)]);
      const collectionIds = project.collections.map((c) => c.collectionId);
      const holders = [...(await this.db.execute<{ address: string; first_at: Date }>(sql`
        SELECT h.address, h.first_at FROM holder_report_holders h
        LEFT JOIN holder_usage u ON u.project_id = h.project_id AND u.address = h.address
        WHERE h.project_id = ${project.id} AND h.first_at IS NOT NULL AND (u.fetched_at IS NULL OR u.fetched_at < ${msDate(Date.now() - RECHECK_DAYS * DAY)})
        ORDER BY u.fetched_at IS NOT NULL, h.rank LIMIT ${calls}`))];
      const ours = async (hashes: string[]) => {
        if (!hashes.length) return new Set<string>();
        const found = await this.db.execute<{ tx_hash: string }>(sql`
          SELECT DISTINCT tx_hash FROM collection_transfers
          WHERE tx_hash IN (SELECT jsonb_array_elements_text(${json(hashes)}::jsonb))
            AND collection_id IN (SELECT (jsonb_array_elements_text(${json(collectionIds)}::jsonb))::uuid)`);
        return new Set([...found].map((r) => r.tx_hash));
      };
      const rows: { a: string; d: unknown }[] = [];
      for (const { address, first_at } of holders) {
        calls--;
        const u = await usageOf(env, address, new Date(first_at).getTime(), contracts, ours);
        if (u) rows.push({ a: address, d: u });
        await sleep(350);
      }
      if (rows.length)
        await this.db.execute(sql`
          INSERT INTO holder_usage (project_id, address, data, fetched_at)
          SELECT ${project.id}::uuid, j.a, j.d, now() FROM jsonb_to_recordset(${json(rows)}::jsonb) AS j(a text, d jsonb)
          ON CONFLICT (project_id, address) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`);
      log.usage += rows.length;
    }
  }
}

/** Each followed collection once, core if any project counts it as core. */
export function uniqueCollections(projects: AnalysisProject[]): AnalysisCollection[] {
  const out = new Map<string, AnalysisCollection>();
  for (const p of projects)
    for (const c of p.collections) {
      const seen = out.get(c.collectionId);
      out.set(c.collectionId, seen ? { ...seen, core: seen.core || c.core } : c);
    }
  return [...out.values()];
}
