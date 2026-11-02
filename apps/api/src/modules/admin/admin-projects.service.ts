import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { type Database, collections, projects } from '@nexus/database';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { CollectionsService } from '../collections/collections.service';

/** Where trackCollection parks contracts nobody has grouped yet (collections.service.ts). */
const UNASSIGNED_SLUG = 'unassigned-contract-intake';

export type ProjectFields = {
  name?: string;
  slug?: string;
  description?: string | null;
  imageUrl?: string | null;
  websiteUrl?: string | null;
  twitterUrl?: string | null;
  discordUrl?: string | null;
};

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
    const slug = await this.freeSlug(input.slug?.trim() ? slugify(input.slug) : slugify(name));

    const [project] = await this.db
      .insert(projects)
      .values({ ...this.pick(input), name, slug })
      .returning();

    for (const collectionId of input.collectionIds ?? []) {
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
            LEFT JOIN projects p ON p.id = c.project_id
            WHERE (c.project_id IS NULL OR p.slug = ${UNASSIGNED_SLUG})
              AND c.is_spam IS NOT TRUE
              AND c.verification_status != 'rejected'
              AND LOWER(c.name) LIKE ${`%${term}%`}
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
      const contract = input.contractAddress.trim();
      const existing = await this.db.query.collections.findFirst({
        where: and(
          eq(collections.chain, input.chain as (typeof collections.$inferSelect)['chain']),
          input.chain === 'solana'
            ? eq(collections.contractAddress, contract)
            : sql`LOWER(${collections.contractAddress}) = ${contract.toLowerCase()}`,
        ),
      });
      if (existing) {
        collectionId = existing.id;
      } else {
        // trackCollection validates the chain and address and starts its first metrics refresh.
        const result = await this.collectionsService.trackCollection({ chain: input.chain, contractAddress: contract });
        collectionId = result.collectionId;
        tracked = true;
      }
    }

    const previousId = await this.setCollectionProject(collectionId, projectId);
    const previous =
      previousId && previousId !== projectId
        ? await this.db.query.projects.findFirst({ where: eq(projects.id, previousId) })
        : undefined;
    // Leaving the intake bucket isn't a move from another project.
    const movedFrom = previous && previous.slug !== UNASSIGNED_SLUG ? { id: previous.id, name: previous.name } : null;
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
