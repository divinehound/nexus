// What a project's admins read from the holder analysis: the report, the holders list, one
// wallet, the related-wallet groups, the activity feed and CSVs; and what they write: their
// shared labels and notes, and pairs of wallets they know are not one person. Each user's own
// nicknames (wallet_nicknames) come along on every wallet.

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import type { Database } from '@nexus/database';
import { toCsv } from '@nexus/holder-analysis';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type AnalysisProject, loadEnabledProjects } from './projects';
import { HolderAnalysisReportService } from './report.service';

const ADDR = /^0x[0-9a-f]{40}$/;
const BURN = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
const DAY_MS = 86_400_000;
const STATUSES = ['active', 'quiet', 'parked', 'dormant_1y', 'dormant_2y', 'dormant_3y', 'dormant_4y', 'unknown'];
const uuids = (ids: string[]) => sql`string_to_array(${ids.join(',')}, ',')::uuid[]`;
const num = (field: string) => sql`(h.data->>${field})::double precision`;

const SORTS: Record<string, SQL> = {
  size: sql`h.rank`,
  newest: sql`h.first_at DESC NULLS LAST, h.rank`,
  oldest: sql`h.first_at ASC NULLS LAST, h.rank`,
  recent: sql`${num('days_since_activity')} ASC NULLS LAST, h.rank`,
  idle: sql`${num('days_since_activity')} DESC NULLS LAST, h.rank`,
  in: sql`${num('tokens_in')} DESC NULLS LAST, h.rank`,
  out: sql`${num('tokens_out')} DESC NULLS LAST, h.rank`,
};

const FEED: Record<string, SQL> = {
  '': sql`TRUE`,
  new: sql`a.flag = 'new'`,
  returned: sql`a.flag = 'returned'`,
  exited: sql`a.flag = 'exited'`,
  ...Object.fromEntries(['bought', 'sold', 'minted', 'received', 'sent', 'burned'].map((k) => [k, sql`a.kind = ${k}`])),
};

export type Paging = { page?: string | number; perPage?: string | number };
const paging = (q: Paging, max = 200) => {
  const perPage = Math.min(max, Math.max(1, Number(q.perPage) || 50));
  const page = Math.max(1, Math.floor(Number(q.page) || 1));
  return { page, perPage, offset: (page - 1) * perPage };
};
const likeOf = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Who a wallet is to the viewer: names, the project's label and note, and the viewer's own nickname. */
const whoJoins = (projectId: string, userId: string, col: SQL) => sql`
  LEFT JOIN wallet_profiles w ON w.chain = 'ethereum' AND w.address = ${col}
  LEFT JOIN holder_wallet_labels n ON n.project_id = ${projectId} AND n.address = ${col}
  LEFT JOIN wallet_nicknames k ON k.user_id = ${userId} AND lower(k.address) = ${col}`;
const whoColumns = sql`w.ens, w.opensea, n.label, n.note, k.nickname`;

@Injectable()
export class HolderAnalysisService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly reports: HolderAnalysisReportService,
  ) {}

  private async rows<T = Record<string, any>>(query: SQL): Promise<T[]> {
    return [...(await this.db.execute<T & Record<string, unknown>>(query))] as T[];
  }

  /** The project as the analysis sees it; 404 when the analysis is off for it. */
  async project(projectId: string): Promise<AnalysisProject> {
    const [project] = await loadEnabledProjects(this.db, projectId);
    if (!project) throw new NotFoundException('Holder analysis is off for this project');
    return project;
  }

  /** The report's summary and when it was made, what the analysis is waiting for, and its collections. */
  async overview(projectId: string, userId: string) {
    const project = await this.project(projectId);
    const [report] = await this.rows(sql`
      SELECT summary, analysis_version, analysed_at, duration_ms FROM holder_reports WHERE project_id = ${projectId}`);
    const { waiting } = await this.reports.readiness(project);
    const top = ((report?.summary?.top_holders ?? []) as { wallet: string }[]).map((h) => h.wallet).filter((w) => ADDR.test(w));
    const who = top.length ? await this.who(projectId, userId, top) : {};
    return {
      projectId,
      name: project.name,
      collections: project.collections.map((c) => ({ id: c.id, collectionId: c.collectionId, name: c.name, chain: c.chain, standard: c.standard, core: c.core })),
      waiting,
      report: report ? { analysedAt: report.analysed_at, version: report.analysis_version, durationMs: report.duration_ms, summary: report.summary } : null,
      who,
    };
  }

  /** Names, labels and nicknames for a list of wallets. */
  async who(projectId: string, userId: string, wallets: string[]) {
    const list = [...new Set(wallets.map((w) => w.toLowerCase()).filter((w) => ADDR.test(w)))].slice(0, 2000);
    if (!list.length) return {};
    const rows = await this.rows(sql`
      SELECT x.address, ${whoColumns}
      FROM unnest(string_to_array(${list.join(',')}, ',')) AS x(address) ${whoJoins(projectId, userId, sql`x.address`)}`);
    return Object.fromEntries(rows.map(({ address, ...r }) => [address, r]));
  }

  /** Holders of the core collections: search, filter, sort and page. */
  async holders(projectId: string, userId: string, q: Paging & { q?: string; show?: string; sort?: string }) {
    await this.project(projectId);
    const { page, perPage, offset } = paging(q);
    const search = (q.q ?? '').trim().toLowerCase();
    const where: SQL[] = [sql`h.project_id = ${projectId}`];
    if (ADDR.test(search)) where.push(sql`h.address = ${search}`);
    else if (search) {
      const like = likeOf(search);
      where.push(sql`(h.address LIKE ${like} OR lower(coalesce(w.ens, h.data->>'ens', '')) LIKE ${like} OR lower(coalesce(w.opensea, h.data->>'opensea_username', '')) LIKE ${like}
        OR lower(coalesce(n.label, '')) LIKE ${like} OR lower(coalesce(n.note, '')) LIKE ${like} OR lower(coalesce(k.nickname, '')) LIKE ${like})`);
    }
    const show = q.show ?? '';
    if (show === 'labelled') where.push(sql`(n.label <> '' OR n.note <> '' OR k.nickname IS NOT NULL)`);
    else if (show === 'new30') where.push(sql`h.first_at > ${new Date(Date.now() - 30 * DAY_MS).toISOString()}`);
    else if (show === 'grouped') where.push(sql`coalesce(h.data->>'cluster', '') <> ''`);
    else if (show === 'dormant') where.push(sql`h.data->>'status' LIKE 'dormant%'`);
    else if (STATUSES.includes(show)) where.push(sql`h.data->>'status' = ${show}`);
    else if (show) throw new BadRequestException(`show must be one of labelled, new30, grouped, dormant, ${STATUSES.join(', ')}`);
    const sort = SORTS[q.sort ?? 'size'];
    if (!sort) throw new BadRequestException(`sort must be one of ${Object.keys(SORTS).join(', ')}`);
    const from = sql`FROM holder_report_holders h ${whoJoins(projectId, userId, sql`h.address`)} WHERE ${sql.join(where, sql` AND `)}`;
    const [{ total }] = await this.rows<{ total: number }>(sql`SELECT count(*)::int AS total ${from}`);
    const rows = await this.rows(sql`
      SELECT h.rank, h.address, h.first_at, h.data, ${whoColumns} ${from} ORDER BY ${sort} LIMIT ${perPage} OFFSET ${offset}`);
    return {
      total,
      page,
      perPage,
      rows: rows.map((r) => ({ rank: r.rank + 1, address: r.address, firstAt: r.first_at, ens: r.ens, opensea: r.opensea, label: r.label, note: r.note, nickname: r.nickname, data: r.data })),
    };
  }

  /** Holders of one non-core collection. */
  async sideHolders(projectId: string, collectionId: string, userId: string, q: Paging) {
    const project = await this.project(projectId);
    const c = project.collections.find((x) => x.collectionId === collectionId);
    if (!c || c.core) throw new NotFoundException('Not a side collection of this project');
    const { page, perPage, offset } = paging(q);
    const [{ total }] = await this.rows<{ total: number }>(sql`
      SELECT count(*)::int AS total FROM holder_report_side_holders WHERE project_id = ${projectId} AND collection_id = ${collectionId}`);
    const rows = await this.rows(sql`
      SELECT h.rank, h.address, h.data, ${whoColumns} FROM holder_report_side_holders h ${whoJoins(projectId, userId, sql`h.address`)}
      WHERE h.project_id = ${projectId} AND h.collection_id = ${collectionId} ORDER BY h.rank LIMIT ${perPage} OFFSET ${offset}`);
    return { total, page, perPage, rows: rows.map((r) => ({ rank: r.rank + 1, address: r.address, ens: r.ens, opensea: r.opensea, label: r.label, note: r.note, nickname: r.nickname, data: r.data })) };
  }

  /** Everything about one wallet in this project: holdings, transfers, groups, links, who funded whom. */
  async wallet(projectId: string, address: string, userId: string, q: Paging) {
    const project = await this.project(projectId);
    const wallet = address.toLowerCase();
    if (!ADDR.test(wallet)) throw new BadRequestException('Not an address');
    const ids = project.collections.map((c) => c.collectionId);
    const { page, perPage, offset } = paging(q, 500);
    const [holder] = await this.rows(sql`SELECT rank, first_at, data FROM holder_report_holders WHERE project_id = ${projectId} AND address = ${wallet}`);
    const side = await this.rows(sql`SELECT collection_id, rank, data FROM holder_report_side_holders WHERE project_id = ${projectId} AND address = ${wallet}`);
    const profiles = await this.rows(sql`
      SELECT chain::text AS chain, is_contract, funder, funded_at, last_out_at, info_at, delegations, ens, opensea FROM wallet_profiles WHERE address = ${wallet}`);
    const [{ total }] = await this.rows<{ total: number }>(sql`
      SELECT count(*)::int AS total FROM collection_transfers t
      WHERE t.collection_id = ANY(${uuids(ids)}) AND (t.from_address = ${wallet} OR t.to_address = ${wallet})`);
    const transfers = await this.rows(sql`
      SELECT t.collection_id, t.block_number, t.log_index, t.block_time, t.tx_hash, t.from_address, t.to_address, t.token_id, t.amount, t.tx_from, t.tx_value_wei::text AS tx_value
      FROM collection_transfers t
      WHERE t.collection_id = ANY(${uuids(ids)}) AND (t.from_address = ${wallet} OR t.to_address = ${wallet})
      ORDER BY t.block_time DESC, t.block_number DESC, t.log_index DESC LIMIT ${perPage} OFFSET ${offset}`);
    const groups = await this.rows(sql`
      SELECT rank, data FROM holder_wallet_groups WHERE project_id = ${projectId} AND (' ' || (data->>'members') || ' ') LIKE ${`% ${wallet} %`}`);
    const links = await this.rows(sql`
      SELECT a, b, score, evidence FROM holder_wallet_links WHERE project_id = ${projectId} AND (a = ${wallet} OR b = ${wallet}) ORDER BY score DESC LIMIT 100`);
    const funded = await this.rows(sql`
      SELECT f.address, f.funded_at, h.rank FROM wallet_profiles f
      LEFT JOIN holder_report_holders h ON h.project_id = ${projectId} AND h.address = f.address
      WHERE f.funder = ${wallet} ORDER BY f.funded_at LIMIT 500`);
    const unlinks = await this.rows(sql`
      SELECT a, b, created_at FROM holder_wallet_unlinks WHERE project_id = ${projectId} AND (a = ${wallet} OR b = ${wallet}) ORDER BY created_at DESC`);
    const activity = await this.rows(sql`
      SELECT at, collection_id, kind, amount, tx_hash, eth, flag FROM holder_activity
      WHERE project_id = ${projectId} AND address = ${wallet} ORDER BY at DESC LIMIT 200`);

    const byId = new Map(project.collections.map((c) => [c.collectionId, c]));
    const others = new Set<string>();
    for (const t of transfers) for (const x of [t.from_address, t.to_address, t.tx_from]) if (x && x !== wallet && !BURN.has(x)) others.add(x);
    for (const l of links) others.add(l.a === wallet ? l.b : l.a);
    for (const f of funded) others.add(f.address);
    for (const p of profiles) if (p.funder) others.add(p.funder);
    for (const g of groups) for (const m of String(g.data.members ?? '').split(' ')) if (m && m !== wallet) others.add(m);
    const who = await this.who(projectId, userId, [wallet, ...others]);

    return {
      address: wallet,
      who: who[wallet] ?? null,
      holder: holder ? { rank: holder.rank + 1, firstAt: holder.first_at, data: holder.data } : null,
      side: side.map((s) => ({ collectionId: s.collection_id, rank: s.rank + 1, data: s.data })),
      profiles: profiles.map((p) => ({
        chain: p.chain,
        isContract: p.is_contract,
        funder: p.funder,
        fundedAt: p.funded_at,
        lastOutAt: p.last_out_at,
        checkedAt: p.info_at,
        delegations: p.delegations,
      })),
      transfers: {
        total,
        page,
        perPage,
        rows: transfers.map((t) => {
          const c = byId.get(t.collection_id);
          return {
            collectionId: t.collection_id,
            block: Number(t.block_number),
            logIndex: t.log_index,
            at: t.block_time,
            tx: t.tx_hash,
            from: t.from_address,
            to: t.to_address,
            tokenId: c?.standard === 'erc20' ? null : t.token_id,
            amount: Number(t.amount),
            txFrom: t.tx_from,
            txValueWei: t.tx_value,
            kind: kindFor(wallet, t as { from_address: string; to_address: string; tx_value: string | null }, c?.staking ?? []),
          };
        }),
      },
      groups: groups.map((g) => ({ rank: g.rank + 1, data: g.data })),
      links: links.map((l) => ({ other: l.a === wallet ? l.b : l.a, score: l.score, evidence: l.evidence })),
      funded: funded.map((f) => ({ address: f.address, fundedAt: f.funded_at, holderRank: f.rank == null ? null : f.rank + 1 })),
      unlinked: unlinks.map((u) => ({ other: u.a === wallet ? u.b : u.a, at: u.created_at })),
      activity: activity.map((a) => ({ at: a.at, collectionId: a.collection_id, kind: a.kind, amount: a.amount, tx: a.tx_hash, eth: a.eth, flag: a.flag })),
      others: who,
    };
  }

  /** Groups of wallets that are likely one person, largest first. */
  async groups(projectId: string, q: Paging) {
    await this.project(projectId);
    const { page, perPage, offset } = paging(q);
    const [{ total }] = await this.rows<{ total: number }>(sql`SELECT count(*)::int AS total FROM holder_wallet_groups WHERE project_id = ${projectId}`);
    const rows = await this.rows(sql`SELECT rank, data FROM holder_wallet_groups WHERE project_id = ${projectId} ORDER BY rank LIMIT ${perPage} OFFSET ${offset}`);
    return { total, page, perPage, rows: rows.map((r) => ({ rank: r.rank + 1, data: r.data })) };
  }

  /** What the last analysis saw happen, newest first. */
  async activity(projectId: string, userId: string, q: Paging & { kind?: string; collectionId?: string; labelled?: string }) {
    const project = await this.project(projectId);
    const { page, perPage, offset } = paging(q);
    const feed = FEED[q.kind ?? ''];
    if (!feed) throw new BadRequestException(`kind must be one of ${Object.keys(FEED).filter(Boolean).join(', ')}`);
    const where: SQL[] = [sql`a.project_id = ${projectId}`, feed];
    if (q.collectionId) {
      if (!project.collections.some((c) => c.collectionId === q.collectionId)) throw new BadRequestException('Not a collection of this project');
      where.push(sql`a.collection_id = ${q.collectionId}`);
    }
    if (q.labelled === '1' || q.labelled === 'true') where.push(sql`(n.label <> '' OR k.nickname IS NOT NULL)`);
    const from = sql`FROM holder_activity a ${whoJoins(projectId, userId, sql`a.address`)} WHERE ${sql.join(where, sql` AND `)}`;
    const [{ total }] = await this.rows<{ total: number }>(sql`SELECT count(*)::int AS total ${from}`);
    const rows = await this.rows(sql`
      SELECT a.at, a.collection_id, a.address, a.kind, a.amount, a.tx_hash, a.eth, a.flag, ${whoColumns} ${from}
      ORDER BY a.at DESC, a.tx_hash, a.address LIMIT ${perPage} OFFSET ${offset}`);
    return {
      total,
      page,
      perPage,
      rows: rows.map((r) => ({
        at: r.at,
        collectionId: r.collection_id,
        address: r.address,
        kind: r.kind,
        amount: r.amount,
        tx: r.tx_hash,
        eth: r.eth,
        flag: r.flag,
        ens: r.ens,
        opensea: r.opensea,
        label: r.label,
        nickname: r.nickname,
      })),
    };
  }

  /** Saves the project's label and note for a wallet (both empty removes them). */
  async saveLabel(projectId: string, address: string, userId: string, body: { label?: unknown; note?: unknown }) {
    await this.project(projectId);
    const wallet = address.toLowerCase();
    if (!ADDR.test(wallet)) throw new BadRequestException('Not an address');
    if ((body?.label != null && typeof body.label !== 'string') || (body?.note != null && typeof body.note !== 'string'))
      throw new BadRequestException('label and note must be text');
    const label = String(body?.label ?? '').trim().slice(0, 100);
    const note = String(body?.note ?? '').trim().slice(0, 2000);
    if (!label && !note) {
      await this.db.execute(sql`DELETE FROM holder_wallet_labels WHERE project_id = ${projectId} AND address = ${wallet}`);
      return { address: wallet, label: '', note: '' };
    }
    await this.db.execute(sql`
      INSERT INTO holder_wallet_labels (project_id, address, label, note, updated_by, updated_at)
      VALUES (${projectId}, ${wallet}, ${label}, ${note}, ${userId}, now())
      ON CONFLICT (project_id, address) DO UPDATE SET label = excluded.label, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
    return { address: wallet, label, note };
  }

  /** Marks (or with `remove`, unmarks) a wallet as not the same person as each of `others`. */
  async saveUnlinks(projectId: string, userId: string, body: { wallet?: unknown; others?: unknown; remove?: unknown }) {
    await this.project(projectId);
    const wallet = String(body?.wallet ?? '').toLowerCase();
    const others = [...new Set((Array.isArray(body?.others) ? body.others : []).map((o) => String(o).toLowerCase()))].filter((o) => ADDR.test(o) && o !== wallet);
    if (!ADDR.test(wallet) || !others.length || others.length > 500) throw new BadRequestException('Send a wallet and up to 500 other wallets');
    const pairs = others.map((o) => (wallet < o ? { a: wallet, b: o } : { a: o, b: wallet }));
    if (body?.remove === true)
      await this.db.execute(sql`
        DELETE FROM holder_wallet_unlinks u USING jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS j(a text, b text)
        WHERE u.project_id = ${projectId} AND u.a = j.a AND u.b = j.b`);
    else
      await this.db.execute(sql`
        INSERT INTO holder_wallet_unlinks (project_id, a, b, created_by)
        SELECT ${projectId}::uuid, j.a, j.b, ${userId}::uuid FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS j(a text, b text)
        ON CONFLICT DO NOTHING`);
    return { pairs: pairs.length };
  }

  // ---- CSV -------------------------------------------------------------------------------

  /** Holders with the project's labels and notes (and the viewer's nicknames). */
  async holdersCsv(projectId: string, userId: string) {
    await this.project(projectId);
    const rows = await this.rows(sql`
      SELECT h.data, n.label, n.note, k.nickname FROM holder_report_holders h ${whoJoins(projectId, userId, sql`h.address`)}
      WHERE h.project_id = ${projectId} ORDER BY h.rank`);
    return toCsv(rows.map((r) => ({ ...r.data, label: r.label ?? '', note: r.note ?? '', my_nickname: r.nickname ?? '' })));
  }

  async sideCsv(projectId: string, collectionId: string) {
    const project = await this.project(projectId);
    if (!project.collections.some((c) => c.collectionId === collectionId && !c.core)) throw new NotFoundException('Not a side collection of this project');
    const rows = await this.rows(sql`
      SELECT data FROM holder_report_side_holders WHERE project_id = ${projectId} AND collection_id = ${collectionId} ORDER BY rank`);
    return toCsv(rows.map((r) => r.data));
  }

  async groupsCsv(projectId: string) {
    await this.project(projectId);
    const rows = await this.rows(sql`SELECT data FROM holder_wallet_groups WHERE project_id = ${projectId} ORDER BY rank`);
    return toCsv(rows.map((r) => r.data));
  }

  async linksCsv(projectId: string) {
    await this.project(projectId);
    const rows = await this.rows(sql`SELECT a, b, score, evidence FROM holder_wallet_links WHERE project_id = ${projectId} ORDER BY score DESC, a, b`);
    return toCsv(rows.map((r) => [r.a, r.b, r.score, r.evidence]), ['wallet_a', 'wallet_b', 'score', 'evidence']);
  }

  /** A collection's transfers, page by page (can be millions of rows): `write` gets each chunk of CSV. */
  async transfersCsv(projectId: string, collectionId: string, write: (chunk: string) => Promise<void> | void) {
    const project = await this.project(projectId);
    const c = project.collections.find((x) => x.collectionId === collectionId);
    if (!c) throw new NotFoundException('Not a collection of this project');
    const header = ['block', 'time_utc', 'tx', 'from', 'to', 'token_id', 'amount', 'tx_sender', 'tx_eth'];
    let after: { b: number; l: number; h: string; k: string } | null = null;
    let first = true;
    for (;;) {
      const rows: Record<string, any>[] = await this.rows(sql`
        SELECT block_number, log_index, block_time, tx_hash, from_address, to_address, token_id, amount, tx_from, tx_value_wei::text AS tx_value
        FROM collection_transfers WHERE collection_id = ${collectionId}
          ${after ? sql`AND (block_number, log_index, tx_hash, token_id) > (${after.b}, ${after.l}, ${after.h}, ${after.k})` : sql``}
        ORDER BY block_number, log_index, tx_hash, token_id LIMIT 5000`);
      const text = toCsv(
        rows.map((r) => [
          r.block_number,
          new Date(r.block_time).toISOString().slice(0, 19).replace('T', ' '),
          r.tx_hash,
          r.from_address,
          r.to_address,
          r.token_id ?? '',
          r.amount,
          r.tx_from ?? '',
          r.tx_value ? Number(BigInt(r.tx_value) / 10n ** 12n) / 1e6 : '',
        ]),
        header,
      );
      await write(first ? text : text.slice(text.indexOf('\n') + 1));
      first = false;
      if (rows.length < 5000) return;
      const last: Record<string, any> = rows[rows.length - 1];
      after = { b: Number(last.block_number), l: last.log_index, h: last.tx_hash, k: last.token_id };
    }
  }

  /** The short id the CSV file names use. */
  async shortIdOf(projectId: string, collectionId: string) {
    return (await this.project(projectId)).collections.find((c) => c.collectionId === collectionId)?.id ?? 'collection';
  }
}

/** What a transfer was for this wallet. */
export function kindFor(w: string, t: { from_address: string; to_address: string; tx_value: string | null }, staking: string[]) {
  const stakes = new Set(staking);
  const paid = !!t.tx_value && t.tx_value !== '0';
  if (t.from_address === w && t.to_address === w) return 'self';
  if (t.to_address === w) return BURN.has(t.from_address) ? 'minted' : stakes.has(t.from_address) ? 'unstaked' : paid ? 'bought' : 'received';
  return BURN.has(t.to_address) ? 'burned' : stakes.has(t.to_address) ? 'staked' : paid ? 'sold' : 'sent';
}
