import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { type Database, collections, holderAnalysisCollectionSettings, projects } from '@nexus/database';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { toProjects } from './projects';

export type CollectionSettingsInput = {
  shortId?: string;
  standard?: string | null;
  core?: boolean;
  decimals?: number;
  stakingContracts?: string[];
  tokenNames?: Record<string, string>;
};

const STANDARDS = ['erc721', 'erc1155', 'erc20'];
const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Turning the holder analysis on for a project, each collection's settings, and how far the sync has got. */
@Injectable()
export class HolderAnalysisAdminService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async setEnabled(projectId: string, enabled: boolean) {
    const [updated] = await this.db
      .update(projects)
      .set({ holderAnalysisEnabled: enabled })
      .where(eq(projects.id, projectId))
      .returning({ id: projects.id });
    if (!updated) throw new NotFoundException('Project not found');
    return this.status(projectId);
  }

  /**
   * The project's switch, its collections as the analysis sees them (settings filled with
   * defaults), each collection's transfer sync, and how many of its holders' wallets are read.
   */
  async status(projectId: string) {
    const project = await this.db.query.projects.findFirst({
      columns: { id: true, name: true, holderAnalysisEnabled: true },
      where: eq(projects.id, projectId),
    });
    if (!project) throw new NotFoundException('Project not found');

    const rows = [
      ...(await this.db.execute<Parameters<typeof toProjects>[0][number]>(sql`
        SELECT p.id AS project_id, p.name AS project_name,
               c.id AS collection_id, c.name AS collection_name, c.chain::text AS chain,
               c.contract_address, c.collection_type::text AS collection_type,
               s.short_id, s.standard, s.core, s.decimals, s.staking_contracts, s.token_names
        FROM projects p
        JOIN collections c ON c.project_id = p.id
        LEFT JOIN holder_analysis_collection_settings s ON s.collection_id = c.id
        WHERE p.id = ${projectId}
        ORDER BY c.first_seen_at, c.id`)),
    ];
    const analysed = toProjects(rows)[0]?.collections ?? [];
    const ids = rows.map((r) => r.collection_id);
    const sync = ids.length
      ? [
          ...(await this.db.execute<{
            collection_id: string;
            last_block: number;
            live: boolean;
            synced_at: Date | null;
            error: string | null;
            error_at: Date | null;
            transfers: number;
            need_tx: number;
          }>(sql`
            SELECT c.id AS collection_id, s.last_block, s.live, s.synced_at, s.error, s.error_at,
              (SELECT count(*)::int FROM collection_transfers t WHERE t.collection_id = c.id) AS transfers,
              (SELECT count(*)::int FROM collection_transfers t WHERE t.collection_id = c.id AND t.need_tx) AS need_tx
            FROM collections c LEFT JOIN collection_transfer_sync s ON s.collection_id = c.id
            WHERE c.id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid)`)),
        ]
      : [];
    const bySync = new Map(sync.map((r) => [r.collection_id, r]));

    const coreIds = analysed.filter((c) => c.core).map((c) => c.collectionId);
    const [wallets] = coreIds.length
      ? [
          ...(await this.db.execute<{ total: number; read: number; delegations: number; named: number }>(sql`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE w.info_at IS NOT NULL)::int AS read,
                   count(*) FILTER (WHERE w.delegations_at IS NOT NULL)::int AS delegations,
                   count(*) FILTER (WHERE w.names_at IS NOT NULL)::int AS named
            FROM wallet_profiles w
            WHERE EXISTS (SELECT 1 FROM collection_transfers t
              WHERE t.to_address = w.address AND t.chain = w.chain
                AND t.collection_id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(coreIds)}::jsonb))::uuid))`)),
        ]
      : [{ total: 0, read: 0, delegations: 0, named: 0 }];

    return {
      projectId: project.id,
      name: project.name,
      enabled: project.holderAnalysisEnabled,
      collections: rows.map((r) => {
        const a = analysed.find((c) => c.collectionId === r.collection_id);
        const s = bySync.get(r.collection_id);
        return {
          collectionId: r.collection_id,
          name: r.collection_name,
          chain: r.chain,
          contractAddress: r.contract_address,
          /** Null when the analysis skips it (Solana, or a type it can't read). */
          settings: a
            ? { shortId: a.id, standard: a.standard, core: a.core, decimals: a.decimals, stakingContracts: a.staking, tokenNames: a.tokenNames, saved: r.short_id !== null }
            : null,
          sync: {
            lastBlock: s?.last_block == null ? null : Number(s.last_block),
            live: s?.live ?? false,
            syncedAt: s?.synced_at ?? null,
            error: s?.error ?? null,
            errorAt: s?.error_at ?? null,
            transfers: s?.transfers ?? 0,
            transactionsPending: s?.need_tx ?? 0,
          },
        };
      }),
      wallets,
    };
  }

  /** Saves a collection's analysis settings; anything left out keeps its current (or default) value. */
  async saveSettings(collectionId: string, input: CollectionSettingsInput) {
    const collection = await this.db.query.collections.findFirst({
      columns: { id: true, name: true, projectId: true, chain: true },
      where: eq(collections.id, collectionId),
    });
    if (!collection) throw new NotFoundException('Collection not found');
    if (collection.chain === 'solana') throw new BadRequestException('Holder analysis reads EVM collections only for now');
    if (!collection.projectId) throw new BadRequestException('Add the collection to a project first');

    const current = (await this.status(collection.projectId)).collections.find((c) => c.collectionId === collectionId)?.settings;
    const shortId = (input.shortId ?? current?.shortId ?? '').trim().toLowerCase();
    if (!/^[a-z0-9]{1,16}$/.test(shortId)) throw new BadRequestException('shortId must be 1 to 16 lowercase letters or digits');
    // Short ids name CSV columns, so they're unique within the project.
    const clash = await this.db.execute<{ id: string }>(sql`
      SELECT s.collection_id AS id FROM holder_analysis_collection_settings s JOIN collections c ON c.id = s.collection_id
      WHERE c.project_id = ${collection.projectId} AND s.short_id = ${shortId} AND s.collection_id != ${collectionId}`);
    if ([...clash].length) throw new BadRequestException(`Another collection of this project already uses "${shortId}"`);

    const standard = input.standard === undefined ? (current?.standard ?? null) : input.standard;
    if (standard !== null && !STANDARDS.includes(standard)) throw new BadRequestException(`standard must be one of ${STANDARDS.join(', ')}`);
    const decimals = input.decimals ?? current?.decimals ?? 0;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new BadRequestException('decimals must be 0 to 36');
    const stakingContracts = (input.stakingContracts ?? current?.stakingContracts ?? []).map((a) => String(a).trim().toLowerCase());
    for (const a of stakingContracts) if (!ADDRESS.test(a)) throw new BadRequestException(`Not an address: ${a}`);
    const tokenNames = input.tokenNames ?? current?.tokenNames ?? {};
    if (typeof tokenNames !== 'object' || Array.isArray(tokenNames)) throw new BadRequestException('tokenNames must map token ids to names');

    const values = {
      shortId,
      standard,
      core: input.core ?? current?.core ?? true,
      decimals,
      stakingContracts,
      tokenNames: Object.fromEntries(Object.entries(tokenNames).map(([k, v]) => [String(k), String(v)])),
      updatedAt: new Date(),
    };
    await this.db
      .insert(holderAnalysisCollectionSettings)
      .values({ collectionId, ...values })
      .onConflictDoUpdate({ target: holderAnalysisCollectionSettings.collectionId, set: values });
    return this.status(collection.projectId);
  }
}
