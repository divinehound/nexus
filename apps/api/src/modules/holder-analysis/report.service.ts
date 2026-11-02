// The holder analysis run for one project: load its transfers and wallet facts from Postgres,
// run analyze() (@nexus/holder-analysis), and replace the project's stored report in one
// transaction, so a page never sees half of one. Ported from the holder analysis Worker
// (spooky-bar apps/holder-analysis/src/report.ts).

import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@nexus/database';
import { ANALYSIS_VERSION, analyze, type Delegation, type Project, type Transfer, type Usage, type WalletInfo } from '@nexus/holder-analysis';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type AnalysisProject, loadEnabledProjects } from './projects';

const PAGE = 20_000;
/**
 * The most transfers one analysis loads. analyze() holds everything in memory on the API's own
 * process (about 1-2 KB a transfer) and blocks its event loop while it runs, so a project bigger
 * than this is refused with an error rather than taking the API down. Raise it with
 * HOLDER_ANALYSIS_MAX_TRANSFERS once the API has the memory, or once the analysis runs in its own process.
 */
const MAX_TRANSFERS = Number(process.env.HOLDER_ANALYSIS_MAX_TRANSFERS) || 500_000;
/** A report this new isn't redone for new transfers alone (the activity feed lags at most this long). */
const NEW_TRANSFERS_AFTER_MS = 30 * 60_000;

const json = (v: unknown) => JSON.stringify(v);
const uuids = (ids: string[]) => sql`string_to_array(${ids.join(',')}, ',')::uuid[]`;
const sec = (d: Date | string | null) => (d == null ? null : new Date(d).getTime() / 1000);
const iso = (s: number | null | undefined) => (s == null ? null : new Date(s * 1000).toISOString());

export type AnalysisResult =
  | { holders: number; groups: number; transfers: number; ms: number }
  | { waiting: string[] }
  | { error: string };

@Injectable()
export class HolderAnalysisReportService {
  private readonly logger = new Logger(HolderAnalysisReportService.name);

  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  /** A project can be analysed once every one of its collections has caught up with the chain. */
  async readiness(project: AnalysisProject): Promise<{ ready: boolean; waiting: string[] }> {
    const ids = project.collections.map((c) => c.collectionId);
    const live = new Set(
      [
        ...(await this.db.execute<{ collection_id: string }>(sql`
          SELECT collection_id FROM collection_transfer_sync WHERE live AND collection_id = ANY(${uuids(ids)})`)),
      ].map((r) => r.collection_id),
    );
    const waiting = project.collections.filter((c) => !live.has(c.collectionId)).map((c) => c.collectionId);
    return { ready: !waiting.length, waiting };
  }

  async analyseProject(project: AnalysisProject) {
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    const ids = project.collections.map((c) => c.collectionId);
    const [{ n }] = [...(await this.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM collection_transfers WHERE collection_id = ANY(${uuids(ids)})`))];
    if (n > MAX_TRANSFERS) throw new Error(`${n} transfers is more than one analysis can hold (HOLDER_ANALYSIS_MAX_TRANSFERS = ${MAX_TRANSFERS})`);
    // The analysis tells collections apart by contract: the same address on two chains gets the chain added.
    const seen = new Map<string, number>();
    for (const c of project.collections) seen.set(c.contract, (seen.get(c.contract) ?? 0) + 1);
    const keyOf = new Map(project.collections.map((c) => [c.collectionId, (seen.get(c.contract) ?? 0) > 1 ? `${c.chain}:${c.contract}` : c.contract]));
    const forAnalysis: Project = {
      id: project.id,
      name: project.name,
      collections: project.collections.map(({ collectionId, chain: _chain, ...c }) => ({ ...c, contract: keyOf.get(collectionId)! })),
    };

    // Addresses and hashes repeat a lot: one string each instead of one per row.
    const strings = new Map<string, string>();
    const one = (v: string | null): string | null => {
      if (v == null) return null;
      const seenStr = strings.get(v);
      if (seenStr !== undefined) return seenStr;
      strings.set(v, v);
      return v;
    };
    const transfers: Transfer[] = [];
    // Every collection, even one with no transfers yet, so the 10-minute check sees the same set.
    const blocks: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const c of project.collections) {
      const contract = keyOf.get(c.collectionId)!;
      // With a chain-prefixed key, the transaction's target is matched against the key too.
      const target = (to: string | null) => (to === c.contract ? contract : one(to));
      let after: { b: number; l: number; h: string; k: string } | null = null;
      for (;;) {
        const rows: Record<string, any>[] = [
          ...(await this.db.execute<Record<string, any>>(sql`
            SELECT block_number, log_index, block_time, tx_hash, from_address, to_address, token_id, amount, tx_from, tx_to, tx_value_wei::text AS tx_value
            FROM collection_transfers
            WHERE collection_id = ${c.collectionId}
              ${after ? sql`AND (block_number, log_index, tx_hash, token_id) > (${after.b}, ${after.l}, ${after.h}, ${after.k})` : sql``}
            ORDER BY block_number, log_index, tx_hash, token_id
            LIMIT ${PAGE}`)),
        ];
        for (const r of rows)
          transfers.push({
            contract,
            block: Number(r.block_number),
            logIndex: r.log_index,
            at: sec(r.block_time)!,
            tx: one(r.tx_hash)!,
            from: one(r.from_address)!,
            to: one(r.to_address)!,
            tokenId: c.standard === 'erc20' ? null : r.token_id,
            amount: Number(r.amount),
            txFrom: one(r.tx_from),
            txTo: target(r.tx_to),
            txValue: r.tx_value === '0' ? '0' : r.tx_value,
          });
        if (rows.length) {
          const last = rows[rows.length - 1];
          after = { b: Number(last.block_number), l: last.log_index, h: last.tx_hash, k: last.token_id };
          blocks[c.collectionId] = after.b;
        }
        if (rows.length < PAGE) break;
      }
    }
    // analyze() expects chain order across collections (a sale can move two collections in one transaction).
    transfers.sort((a, b) => a.at - b.at || a.block - b.block || a.logIndex - b.logIndex);

    // Facts about the wallets that received the project's tokens. Funder and activity come from the
    // project's main chain (its first core collection's) first, then its other chains; names and
    // delegations are kept on Ethereum.
    const mainChain = (project.collections.find((c) => c.core) ?? project.collections[0]).chain;
    const chains = [...new Set([...project.collections.map((c) => c.chain), 'ethereum'])];
    const wallets = new Map<string, WalletInfo>();
    const delegations = new Map<string, Delegation[]>();
    const ens = new Map<string, string>();
    const opensea = new Map<string, string>();
    // A delegation scoped to a collection names its real contract: use the analysis' key for it.
    const ethKey = new Map(project.collections.filter((c) => c.chain === 'ethereum').map((c) => [c.contract, keyOf.get(c.collectionId)!]));
    const projectChains = new Set(project.collections.map((c) => c.chain));
    const profiles = await this.db.execute<Record<string, any>>(sql`
      SELECT w.chain::text AS chain, w.address, w.is_contract, w.funder, w.funded_at, w.last_out_at, w.info_at, w.delegations, w.ens, w.opensea
      FROM wallet_profiles w
      WHERE w.chain::text = ANY(string_to_array(${chains.join(',')}, ','))
        AND w.address IN (SELECT f.address FROM holder_analysis_wallets f WHERE f.collection_id = ANY(${uuids(ids)}))
      ORDER BY w.chain::text = ${mainChain} DESC`);
    for (const r of profiles) {
      const address = one(r.address)!;
      if (r.info_at != null && projectChains.has(r.chain) && !wallets.has(address))
        wallets.set(address, { contract: r.is_contract, funder: one(r.funder), fundedAt: sec(r.funded_at), lastOutAt: sec(r.last_out_at) });
      if (r.chain !== 'ethereum') continue;
      if (r.delegations) delegations.set(address, (r.delegations as Delegation[]).map((d) => (d.contract && ethKey.has(d.contract) ? { ...d, contract: ethKey.get(d.contract)! } : d)));
      if (r.ens) ens.set(address, r.ens);
      if (r.opensea) opensea.set(address, r.opensea);
    }
    const usage = new Map(
      [...(await this.db.execute<{ address: string; data: Usage }>(sql`SELECT address, data FROM holder_usage WHERE project_id = ${project.id}`))].map((u) => [u.address, u.data]),
    );
    const unlinks = new Set(
      [...(await this.db.execute<{ a: string; b: string }>(sql`SELECT a, b FROM holder_wallet_unlinks WHERE project_id = ${project.id}`))].map((u) => `${u.a}|${u.b}`),
    );

    const t1 = Date.now();
    const r = analyze({ project: forAnalysis, transfers, wallets, delegations, ens, opensea, usage, unlinks, now: Date.now() / 1000 });
    const t2 = Date.now();
    const byShort = new Map(project.collections.map((c) => [c.id, c.collectionId]));
    r.summary.timing = { load_ms: t1 - t0, analyse_ms: t2 - t1, transfers: transfers.length };
    // What this report saw, so the 10-minute check can tell when it's out of date.
    r.summary.blocks = blocks;
    r.summary.collections = project.collections.map((c) => ({ id: c.id, collectionId: c.collectionId, chain: c.chain, name: c.name, core: c.core, standard: c.standard }));

    const p = project.id;
    await this.db.transaction(async (tx) => {
      // One save per project at a time, even if two API instances analyse it at once.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'holder-analysis:' + p}))`);
      for (const table of ['holder_report_holders', 'holder_report_side_holders', 'holder_wallet_groups', 'holder_wallet_links', 'holder_activity'])
        await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE project_id = ${p}`);
      const chunks = <T>(rows: T[], n = 2000) => Array.from({ length: Math.ceil(rows.length / n) }, (_, i) => rows.slice(i * n, i * n + n));
      for (const part of chunks(r.holders.map((h, i) => ({ r: i, a: h.wallet, f: iso(r.firstAt.get(h.wallet as string)), d: h }))))
        await tx.execute(sql`
          INSERT INTO holder_report_holders (project_id, address, rank, first_at, data)
          SELECT ${p}::uuid, j.a, j.r, j.f, j.d FROM jsonb_to_recordset(${json(part)}::jsonb) AS j(r int, a text, f timestamptz, d jsonb)`);
      for (const [short, rows] of Object.entries(r.side)) {
        const collectionId = byShort.get(short);
        if (!collectionId) continue;
        for (const part of chunks(rows.map((h, i) => ({ r: i, a: h.wallet, d: h }))))
          await tx.execute(sql`
            INSERT INTO holder_report_side_holders (project_id, collection_id, address, rank, data)
            SELECT ${p}::uuid, ${collectionId}::uuid, j.a, j.r, j.d FROM jsonb_to_recordset(${json(part)}::jsonb) AS j(r int, a text, d jsonb)`);
      }
      for (const part of chunks(r.clusters.map((g, i) => ({ r: i, d: g }))))
        await tx.execute(sql`
          INSERT INTO holder_wallet_groups (project_id, rank, data)
          SELECT ${p}::uuid, j.r, j.d FROM jsonb_to_recordset(${json(part)}::jsonb) AS j(r int, d jsonb)`);
      for (const part of chunks(r.links.map(([a, b, s, e]) => ({ a, b, s, e }))))
        await tx.execute(sql`
          INSERT INTO holder_wallet_links (project_id, a, b, score, evidence)
          SELECT ${p}::uuid, j.a, j.b, j.s, j.e FROM jsonb_to_recordset(${json(part)}::jsonb) AS j(a text, b text, s real, e text)
          ON CONFLICT DO NOTHING`);
      const activity = r.activity.flatMap((a) => {
        const c = byShort.get(a.coll);
        return c ? [{ at: iso(a.at), c, w: a.wallet, k: a.kind, n: a.amount, h: a.tx, e: a.eth, f: a.flag }] : [];
      });
      for (const part of chunks(activity))
        await tx.execute(sql`
          INSERT INTO holder_activity (project_id, at, collection_id, address, kind, amount, tx_hash, eth, flag)
          SELECT ${p}::uuid, j.at, j.c, j.w, j.k, j.n, j.h, j.e, j.f
          FROM jsonb_to_recordset(${json(part)}::jsonb) AS j(at timestamptz, c uuid, w text, k text, n double precision, h text, e double precision, f text)`);
      const block = Math.max(0, ...Object.values(blocks));
      await tx.execute(sql`
        INSERT INTO holder_reports (project_id, summary, analysis_version, block, duration_ms, analysed_at)
        VALUES (${p}, ${json(r.summary)}::jsonb, ${ANALYSIS_VERSION}, ${block}, ${Date.now() - t0}, ${startedAt})
        ON CONFLICT (project_id) DO UPDATE SET summary = excluded.summary, analysis_version = excluded.analysis_version,
          block = excluded.block, duration_ms = excluded.duration_ms, analysed_at = excluded.analysed_at`);
    });
    return { holders: r.holders.length, groups: r.clusters.length, transfers: transfers.length, ms: Date.now() - t0 };
  }

  /** Analyses one project (turned on and caught up), or says what it's waiting for. */
  async analyseOne(projectId: string): Promise<AnalysisResult> {
    const [project] = await loadEnabledProjects(this.db, projectId);
    if (!project) return { error: 'Holder analysis is off for this project, or it has no EVM collections' };
    return this.run(project);
  }

  /**
   * Every project that's turned on and ready, or (`changedOnly`, after each sync) only those with
   * no report yet, one made by an older analysis, collection settings or collections changed since,
   * or new transfers (at most every half hour).
   */
  async analyseDue(opts: { changedOnly: boolean }): Promise<Record<string, AnalysisResult>> {
    const out: Record<string, AnalysisResult> = {};
    const projects = await loadEnabledProjects(this.db);
    if (!projects.length) return out;
    const reports = new Map(
      [
        ...(await this.db.execute<{ project_id: string; analysed_at: Date; analysis_version: number; blocks: Record<string, number> | null; settings_at: Date | null }>(sql`
          SELECT r.project_id, r.analysed_at, r.analysis_version, r.summary->'blocks' AS blocks,
            (SELECT max(s.updated_at) FROM holder_analysis_collection_settings s JOIN collections c ON c.id = s.collection_id WHERE c.project_id = r.project_id) AS settings_at
          FROM holder_reports r WHERE r.project_id = ANY(${uuids(projects.map((p) => p.id))})`)),
      ].map((r) => [r.project_id, r]),
    );
    for (const project of projects) {
      if (opts.changedOnly) {
        const r = reports.get(project.id);
        if (r && r.analysis_version === ANALYSIS_VERSION && !(r.settings_at && new Date(r.settings_at) > new Date(r.analysed_at))) {
          const seen = r.blocks ?? {};
          const ids = project.collections.map((c) => c.collectionId);
          const sameCollections = ids.length === Object.keys(seen).length && ids.every((id) => id in seen);
          if (sameCollections) {
            if (Date.now() - new Date(r.analysed_at).getTime() < NEW_TRANSFERS_AFTER_MS) continue;
            const newest = await this.db.execute<{ collection_id: string; b: number | null }>(sql`
              SELECT c.id AS collection_id, (SELECT max(t.block_number) FROM collection_transfers t WHERE t.collection_id = c.id) AS b
              FROM unnest(${uuids(ids)}) AS c(id)`);
            if ([...newest].every((n) => Number(n.b ?? 0) <= (seen[n.collection_id] ?? 0))) continue;
          }
        }
      }
      out[project.id] = await this.run(project);
    }
    return out;
  }

  private async run(project: AnalysisProject): Promise<AnalysisResult> {
    const { ready, waiting } = await this.readiness(project);
    if (!ready) return { waiting };
    try {
      return await this.analyseProject(project);
    } catch (err) {
      this.logger.error(`Holder analysis of ${project.name} (${project.id}): ${err instanceof Error ? err.stack : err}`);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
