import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { type Database, collections, projects } from '@nexus/database';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { CollectionsService } from '../collections/collections.service';

export type ProjectFields = {
  name?: string;
  slug?: string;
  description?: string | null;
  imageUrl?: string | null;
  websiteUrl?: string | null;
  twitterUrl?: string | null;
  discordUrl?: string | null;
};

/** Most projects one bulk delete takes. */
export const MAX_BULK_DELETE = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EDITABLE: (keyof ProjectFields)[] = ['name', 'slug', 'description', 'imageUrl', 'websiteUrl', 'twitterUrl', 'discordUrl'];

const COLLECTION_COLUMNS = {
  id: true,
  name: true,
  chain: true,
  contractAddress: true,
  imageUrl: true,
  holderCount: true,
  supply: true,
  verificationStatus: true,
  mappingStatus: true,
  isSpam: true,
} as const;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Escapes LIKE wildcards so a name such as "100%" or "my_nft" matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Grouping collections into projects from the admin: create and edit a project,
 * add collections to it (by search or by pasting a contract) and take them out,
 * and see which collections are likely to belong to it.
 */
@Injectable()
export class AdminProjectsService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly collectionsService: CollectionsService,
  ) {}

  async createProject(input: ProjectFields & { collectionIds?: string[] }) {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('name is required');
    const collectionIds = [...new Set(input.collectionIds ?? [])];
    // Check the collections before creating anything, so a bad id doesn't leave a half-made project.
    for (const collectionId of collectionIds) {
      const found = await this.db.query.collections.findFirst({
        columns: { id: true },
        where: eq(collections.id, collectionId),
      });
      if (!found) throw new NotFoundException(`Collection ${collectionId} not found`);
    }
    const slug = await this.freeSlug(input.slug?.trim() ? slugify(input.slug) : slugify(name));

    const [project] = await this.db
      .insert(projects)
      .values({ ...this.pick(input), name, slug })
      .returning();

    for (const collectionId of collectionIds) {
      await this.setCollectionProject(collectionId, project.id);
    }
    return this.getProject(project.id);
  }

  async updateProject(projectId: string, input: ProjectFields) {
    const changes = this.pick(input);
    if (changes.name !== undefined && !changes.name?.trim()) throw new BadRequestException('name cannot be empty');
    if (changes.slug !== undefined) {
      const slug = slugify(changes.slug ?? '');
      if (!slug) throw new BadRequestException('slug cannot be empty');
      const taken = await this.db.query.projects.findFirst({
        where: and(eq(projects.slug, slug), ne(projects.id, projectId)),
      });
      if (taken) throw new ConflictException(`The slug "${slug}" is already used by ${taken.name}`);
      changes.slug = slug;
    }
    if (Object.keys(changes).length === 0) return this.getProject(projectId);

    const [updated] = await this.db.update(projects).set(changes).where(eq(projects.id, projectId)).returning();
    if (!updated) throw new NotFoundException('Project not found');
    return this.getProject(projectId);
  }

  /** The project, its collections, and collections that probably belong to it. */
  async getProject(projectId: string) {
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { collections: { columns: COLLECTION_COLUMNS, orderBy: [asc(collections.name)] } },
    });
    if (!project) throw new NotFoundException('Project not found');

    // Suggested for this project by an admin or the mapping heuristics.
    const proposed = await this.db.query.collections.findMany({
      columns: COLLECTION_COLUMNS,
      where: and(eq(collections.proposedProjectId, projectId), sql`${collections.projectId} IS DISTINCT FROM ${projectId}`),
      limit: 50,
    });

    // Ungrouped collections whose name contains the project's name (3+ letters).
    const term = project.name.trim().toLowerCase();
    const nameMatches =
      term.length >= 3
        ? await this.db.execute<{ id: string }>(sql`
            SELECT c.id
            FROM collections c
            WHERE c.project_id IS NULL
              AND c.is_spam IS NOT TRUE
              AND c.verification_status != 'rejected'
              AND LOWER(c.name) LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\'
            ORDER BY c.holder_count DESC NULLS LAST
            LIMIT 20
          `)
        : [];
    const proposedIds = new Set(proposed.map((c) => c.id));
    const matchIds = [...nameMatches].map((r) => r.id).filter((id) => !proposedIds.has(id));
    const named = matchIds.length
      ? await this.db.query.collections.findMany({
          columns: COLLECTION_COLUMNS,
          where: sql`${collections.id} IN (${sql.join(matchIds.map((id) => sql`${id}`), sql`, `)})`,
        })
      : [];

    return {
      ...project,
      suggestions: [
        ...proposed.map((c) => ({ ...c, reason: 'suggested' as const })),
        ...named.map((c) => ({ ...c, reason: 'name' as const })),
      ],
    };
  }

  /**
   * Add a collection to the project: by id, or by chain + contract. A contract
   * Nexus doesn't track yet is tracked first. A collection in another project
   * moves here.
   */
  async addCollection(projectId: string, input: { collectionId?: string; chain?: string; contractAddress?: string }) {
    await this.requireProject(projectId);

    let collectionId = input.collectionId;
    let tracked = false;
    if (!collectionId) {
      if (!input.chain || !input.contractAddress) {
        throw new BadRequestException('Send a collectionId, or a chain and contractAddress');
      }
      // Validate first: an unknown chain would otherwise reach Postgres as a bad enum value (a 500).
      const chain = this.collectionsService.validateChain(input.chain);
      const contract = this.collectionsService.normalizeAndValidateAddress(chain, input.contractAddress);
      const existing = await this.db.query.collections.findFirst({
        where: and(
          eq(collections.chain, chain),
          chain === 'solana'
            ? eq(collections.contractAddress, contract)
            : sql`LOWER(${collections.contractAddress}) = ${contract}`,
        ),
      });
      if (existing) {
        collectionId = existing.id;
      } else {
        // trackCollection validates the chain and address and starts its first metrics refresh.
        const result = await this.collectionsService.trackCollection({ chain, contractAddress: contract });
        collectionId = result.collectionId;
        tracked = true;
      }
    }

    const previousId = await this.setCollectionProject(collectionId, projectId);
    const previous =
      previousId && previousId !== projectId
        ? await this.db.query.projects.findFirst({ where: eq(projects.id, previousId) })
        : undefined;
    const movedFrom = previous ? { id: previous.id, name: previous.name } : null;
    return { collectionId, tracked, movedFrom };
  }

  async removeCollection(projectId: string, collectionId: string) {
    const collection = await this.db.query.collections.findFirst({ where: eq(collections.id, collectionId) });
    if (!collection || collection.projectId !== projectId) {
      throw new NotFoundException('That collection is not in this project');
    }
    await this.db
      .update(collections)
      .set({ projectId: null, mappingStatus: 'unmapped', lastSeenAt: new Date() })
      .where(eq(collections.id, collectionId));
    return { collectionId, removed: true };
  }

  /**
   * Deletes projects without deleting their collections.
   *
   * collections.project_id cascades on delete, so deleting a project row on its
   * own would also delete its collections (and their holders, sales and metrics).
   * Here the collections are taken out of the project first and stay tracked,
   * unmapped. Pending suggestions pointing at a deleted project are cleared.
   * Data that belongs to the project itself goes with it: owners, wiki pages and
   * suggestions, events, activity feed rows and its holder-analysis data.
   *
   * With markCollectionsSpam, the unlinked collections are also flagged as spam
   * (manual, score 100), as marking one collection as spam from the admin does.
   */
  async deleteProjects(projectIds: unknown, opts: { markCollectionsSpam?: boolean } = {}) {
    if (!Array.isArray(projectIds) || projectIds.some((id) => typeof id !== 'string')) {
      throw new BadRequestException('projectIds must be an array of project ids');
    }
    const ids = [...new Set(projectIds as string[])];
    if (ids.length === 0) throw new BadRequestException('Choose at least one project');
    if (ids.length > MAX_BULK_DELETE) {
      throw new BadRequestException(`Delete at most ${MAX_BULK_DELETE} projects at a time`);
    }
    const invalid = ids.filter((id) => !UUID_RE.test(id));
    if (invalid.length) throw new BadRequestException(`Not a project id: ${invalid.slice(0, 3).join(', ')}`);

    return this.db.transaction(async (tx) => {
      // FOR UPDATE stops a collection being added to one of these projects while we
      // work: that insert needs a key-share lock on the project row. Otherwise the
      // new collection would be deleted with the project by the cascade.
      const found = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(inArray(projects.id, ids))
        .for('update');
      const foundIds = new Set(found.map((p) => p.id));
      const notFound = ids.filter((id) => !foundIds.has(id));
      const targetIds = [...foundIds];
      if (targetIds.length === 0) {
        return { deleted: [], unlinkedCollections: 0, flaggedSpam: 0, notFound };
      }

      const now = new Date();
      // Flag first, and only collections not already flagged, so an earlier
      // detection keeps its source, reason and time.
      const flagged = opts.markCollectionsSpam
        ? await tx
            .update(collections)
            .set({
              isSpam: true,
              spamScore: 100,
              spamReason: 'project_deleted_as_spam',
              spamDetectedAt: now,
              spamDetectedBy: 'manual',
            })
            .where(and(inArray(collections.projectId, targetIds), sql`${collections.isSpam} IS NOT TRUE`))
            .returning({ id: collections.id })
        : [];

      // Only "mapped" means mapped to this project; a "suggested" (for another
      // project) or "rejected" status is left as it is.
      const unlinked = await tx
        .update(collections)
        .set({
          projectId: null,
          mappingStatus: sql`CASE WHEN ${collections.mappingStatus} = 'mapped' THEN 'unmapped'::mapping_status ELSE ${collections.mappingStatus} END`,
          lastSeenAt: now,
        })
        .where(inArray(collections.projectId, targetIds))
        .returning({ id: collections.id });

      // proposed_project_id is ON DELETE SET NULL, which would leave these
      // "suggested" with nothing suggested; put them back to unmapped.
      await tx
        .update(collections)
        .set({
          proposedProjectId: null,
          mappingConfidence: null,
          mappingStatus: sql`CASE WHEN ${collections.mappingStatus} = 'suggested' THEN 'unmapped'::mapping_status ELSE ${collections.mappingStatus} END`,
        })
        .where(inArray(collections.proposedProjectId, targetIds));

      const deleted = await tx
        .delete(projects)
        .where(inArray(projects.id, targetIds))
        .returning({ id: projects.id, name: projects.name });

      return {
        deleted,
        unlinkedCollections: unlinked.length,
        flaggedSpam: flagged.length,
        notFound,
      };
    });
  }

  /** Deletes one project, keeping its collections (see deleteProjects). */
  async deleteProject(projectId: string) {
    const result = await this.deleteProjects([projectId]);
    if (result.deleted.length === 0) throw new NotFoundException('Project not found');
    return { deleted: true, unlinkedCollections: result.unlinkedCollections };
  }

  /** Moves a collection into the project; returns the project it was in before. */
  private async setCollectionProject(collectionId: string, projectId: string): Promise<string | null> {
    const collection = await this.db.query.collections.findFirst({ where: eq(collections.id, collectionId) });
    if (!collection) throw new NotFoundException(`Collection ${collectionId} not found`);
    await this.db
      .update(collections)
      .set({ projectId, mappingStatus: 'mapped', proposedProjectId: null, lastSeenAt: new Date() })
      .where(eq(collections.id, collectionId));
    return collection.projectId;
  }

  private async requireProject(projectId: string) {
    const project = await this.db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  /** The slug, or the slug with -2, -3… when it's taken. */
  private async freeSlug(base: string): Promise<string> {
    const root = base || 'project';
    for (let n = 1; n < 100; n++) {
      const slug = n === 1 ? root : `${root}-${n}`;
      const taken = await this.db.query.projects.findFirst({ where: eq(projects.slug, slug) });
      if (!taken) return slug;
    }
    throw new ConflictException(`No free slug for "${root}"`);
  }

  private pick(input: ProjectFields): ProjectFields {
    const out: Record<string, string | null> = {};
    for (const key of EDITABLE) {
      const value = input[key];
      if (value === undefined) continue;
      if (key === 'name' || key === 'slug') out[key] = String(value ?? '').trim();
      else out[key] = typeof value === 'string' ? value.trim() || null : null;
    }
    return out as ProjectFields;
  }
}
