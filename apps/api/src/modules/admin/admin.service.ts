import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { eq, and, count, sql, desc, or } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  type Database,
  projects,
  users,
  wikiSuggestions,
  projectWiki,
  events,
  projectOwners,
  collections,
  indexingJobs,
  walletIndexingJobs,
  wallets,
  spamAllowlist,
} from '@nexus/database';
import { CollectionMetricsService } from '../collections/collection-metrics.service';
import { HoldingsService } from '../holdings/holdings.service';
import { BlockchainLookupService } from '../search/blockchain-lookup.service';
import { HolderIndexerService } from '../indexing/holder-indexer.service';
import { SpamCheckerService } from '../indexing/spam-checker.service';
import { CollectionDiscoveryService } from '../indexing/collection-discovery.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly collectionMetricsService: CollectionMetricsService,
    private readonly holdingsService: HoldingsService,
    private readonly blockchainLookup: BlockchainLookupService,
    private readonly holderIndexerService: HolderIndexerService,
    private readonly spamCheckerService: SpamCheckerService,
    private readonly collectionDiscoveryService: CollectionDiscoveryService,
  ) {}

  /**
   * Helper: Resolve collection ID from UUID or contract address
   */
  private async resolveCollectionId(idOrContract: string): Promise<string> {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrContract);
    
    if (isUUID) {
      return idOrContract;
    }
    
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.contractAddress, idOrContract),
    });
    
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    
    return collection.id;
  }

  // --- Dashboard Stats ---

  async getStats() {
    const [[projectCount], [userCount], [pendingSuggestions], [eventCount]] =
      await Promise.all([
        this.db.select({ value: count() }).from(projects),
        this.db.select({ value: count() }).from(users),
        this.db
          .select({ value: count() })
          .from(wikiSuggestions)
          .where(eq(wikiSuggestions.status, 'pending')),
        this.db.select({ value: count() }).from(events),
      ]);

    return {
      projects: projectCount.value,
      users: userCount.value,
      pendingWikiSuggestions: pendingSuggestions.value,
      events: eventCount.value,
    };
  }

  // --- Project Management ---

  async listProjects(page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    const items = await this.db.query.projects.findMany({
      limit,
      offset,
      with: { collections: true },
      orderBy: (projects, { desc }) => [desc(projects.createdAt)],
    });
    const [[total]] = await Promise.all([
      this.db.select({ value: count() }).from(projects),
    ]);
    return { items, total: total.value, page, limit };
  }

  async setProjectVerified(projectId: string, isVerified: boolean) {
    const [updated] = await this.db
      .update(projects)
      .set({ isVerified })
      .where(eq(projects.id, projectId))
      .returning();
    if (!updated) throw new NotFoundException('Project not found');

    if (!isVerified) {
      return { ...updated, indexing: null };
    }

    const indexing = await this.collectionMetricsService.refreshProjectMetricsNow(projectId);

    return {
      ...updated,
      indexing: {
        queued: indexing.queued,
        deduped: indexing.deduped,
        jobId: indexing.jobId,
        childCollectionsQueued: indexing.childCollectionJobs.length,
      },
    };
  }

  async setProjectFeatured(projectId: string, isFeatured: boolean) {
    const [updated] = await this.db
      .update(projects)
      .set({ isFeatured })
      .where(eq(projects.id, projectId))
      .returning();
    if (!updated) throw new NotFoundException('Project not found');
    return updated;
  }

  async deleteProject(projectId: string) {
    const [deleted] = await this.db
      .delete(projects)
      .where(eq(projects.id, projectId))
      .returning();
    if (!deleted) throw new NotFoundException('Project not found');
    return { deleted: true };
  }

  // --- Collections Search ---

  async searchCollections(query: string, limit: number = 20) {
    if (!query || query.trim().length < 2) {
      throw new BadRequestException('Search query must be at least 2 characters');
    }

    const lowerQuery = query.toLowerCase();

    const results = await this.db.query.collections.findMany({
      where: or(
        sql`LOWER(${collections.name}) LIKE ${`%${lowerQuery}%`}`,
        sql`LOWER(${collections.contractAddress}) LIKE ${`%${lowerQuery}%`}`,
      ),
      limit,
      with: {
        project: {
          columns: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

    return results.map((c) => ({
      id: c.id,
      name: c.name,
      chain: c.chain,
      contractAddress: c.contractAddress,
      imageUrl: c.imageUrl,
      holderCount: c.holderCount,
      verificationStatus: c.verificationStatus,
      mappingStatus: c.mappingStatus,
      isSpam: c.isSpam,
      spamScore: c.spamScore,
      project: c.project,
    }));
  }

  // --- Wiki Suggestions ---

  async listWikiSuggestions(status?: string) {
    if (status) {
      return this.db.query.wikiSuggestions.findMany({
        where: eq(
          wikiSuggestions.status,
          status as 'pending' | 'approved' | 'rejected',
        ),
        orderBy: [desc(wikiSuggestions.createdAt)],
      });
    }
    return this.db.query.wikiSuggestions.findMany({
      orderBy: [desc(wikiSuggestions.createdAt)],
    });
  }

  async approveWikiSuggestion(suggestionId: string) {
    const suggestion = await this.db.query.wikiSuggestions.findFirst({
      where: eq(wikiSuggestions.id, suggestionId),
    });
    if (!suggestion) throw new NotFoundException('Suggestion not found');

    // Apply the suggestion to the wiki
    const existingWiki = await this.db.query.projectWiki.findFirst({
      where: eq(projectWiki.projectId, suggestion.projectId),
    });

    if (existingWiki) {
      await this.db
        .update(projectWiki)
        .set({
          [suggestion.field]: suggestion.proposedValue,
          lastEditedBy: suggestion.submittedBy,
          lastEditedAt: new Date(),
          revisionNumber: sql`${projectWiki.revisionNumber} + 1`,
        })
        .where(eq(projectWiki.id, existingWiki.id));
    } else {
      await this.db.insert(projectWiki).values({
        projectId: suggestion.projectId,
        [suggestion.field]: suggestion.proposedValue,
        lastEditedBy: suggestion.submittedBy,
        lastEditedAt: new Date(),
      });
    }

    // Mark suggestion as approved
    const [updated] = await this.db
      .update(wikiSuggestions)
      .set({ status: 'approved' })
      .where(eq(wikiSuggestions.id, suggestionId))
      .returning();

    return updated;
  }

  async rejectWikiSuggestion(suggestionId: string) {
    const [updated] = await this.db
      .update(wikiSuggestions)
      .set({ status: 'rejected' })
      .where(eq(wikiSuggestions.id, suggestionId))
      .returning();
    if (!updated) throw new NotFoundException('Suggestion not found');
    return updated;
  }

  // --- Event Management ---

  async listAllEvents(status?: string) {
    if (status) {
      return this.db.query.events.findMany({
        where: eq(events.status, status as 'upcoming' | 'live' | 'ended'),
        orderBy: [desc(events.createdAt)],
      });
    }
    return this.db.query.events.findMany({
      orderBy: [desc(events.createdAt)],
    });
  }

  async deleteEvent(eventId: string) {
    const [deleted] = await this.db
      .delete(events)
      .where(eq(events.id, eventId))
      .returning();
    if (!deleted) throw new NotFoundException('Event not found');
    return { deleted: true };
  }

  async updateEventStatus(
    eventId: string,
    status: 'upcoming' | 'live' | 'ended',
  ) {
    const [updated] = await this.db
      .update(events)
      .set({ status })
      .where(eq(events.id, eventId))
      .returning();
    if (!updated) throw new NotFoundException('Event not found');
    return updated;
  }

  // --- Collection Verification / Mapping ---

  async verifyCollection(
    idOrContract: string,
    input: { notes?: string; projectId?: string },
  ) {
    const collectionId = await this.resolveCollectionId(idOrContract);
    const existing = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });
    if (!existing) throw new NotFoundException('Collection not found');

    if (input.projectId) {
      const project = await this.db.query.projects.findFirst({
        where: eq(projects.id, input.projectId),
      });
      if (!project) throw new NotFoundException('Project not found');
    }

    const previousProjectId = existing.projectId;
    const nextProjectId = input.projectId ?? existing.projectId;

    const [updated] = await this.db
      .update(collections)
      .set({
        verificationStatus: 'verified',
        mappingStatus: input.projectId ? 'mapped' : existing.mappingStatus,
        projectId: nextProjectId,
        proposedProjectId: input.projectId ?? existing.proposedProjectId,
        verificationNotes: input.notes ?? existing.verificationNotes,
        lastSeenAt: new Date(),
      })
      .where(eq(collections.id, collectionId))
      .returning();

    const collectionIndexing = await this.collectionMetricsService.refreshCollectionMetricsNow(
      collectionId,
    );

    const projectIdsToRefresh = new Set<string>();
    if (previousProjectId) projectIdsToRefresh.add(previousProjectId);
    if (nextProjectId) projectIdsToRefresh.add(nextProjectId);

    const projectIndexing = [] as Array<{
      projectId: string;
      jobId: string;
      deduped: boolean;
    }>;

    for (const projectId of projectIdsToRefresh) {
      const refresh = await this.collectionMetricsService.refreshProjectMetricsNow(projectId);
      projectIndexing.push({
        projectId,
        jobId: refresh.jobId,
        deduped: refresh.deduped,
      });
    }

    return {
      ...updated,
      indexing: {
        collection: {
          jobId: collectionIndexing.jobId,
          deduped: collectionIndexing.deduped,
        },
        projects: projectIndexing,
      },
    };
  }

  async rejectCollection(idOrContract: string, notes?: string) {
    const collectionId = await this.resolveCollectionId(idOrContract);
    const [updated] = await this.db
      .update(collections)
      .set({
        verificationStatus: 'rejected',
        mappingStatus: 'rejected',
        verificationNotes: notes ?? null,
        lastSeenAt: new Date(),
      })
      .where(eq(collections.id, collectionId))
      .returning();

    if (!updated) throw new NotFoundException('Collection not found');
    return updated;
  }

  async suggestProject(
    collectionId: string,
    input: { projectId: string; confidence: number; notes?: string },
  ) {
    if (typeof input.confidence !== 'number' || Number.isNaN(input.confidence)) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'confidence must be a number between 0 and 1',
      });
    }

    if (input.confidence < 0 || input.confidence > 1) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'confidence must be between 0 and 1',
      });
    }

    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });
    if (!collection) throw new NotFoundException('Collection not found');

    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, input.projectId),
    });
    if (!project) throw new NotFoundException('Project not found');

    const [updated] = await this.db
      .update(collections)
      .set({
        mappingStatus: 'suggested',
        proposedProjectId: input.projectId,
        mappingConfidence: input.confidence.toString(),
        verificationStatus:
          collection.verificationStatus === 'tracked_unverified'
            ? 'pending_claim'
            : collection.verificationStatus,
        verificationNotes: input.notes ?? collection.verificationNotes,
        lastSeenAt: new Date(),
      })
      .where(eq(collections.id, collectionId))
      .returning();

    return updated;
  }

  // --- User Management ---

  async listUsers(page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    const items = await this.db.query.users.findMany({
      limit,
      offset,
      orderBy: (users, { desc }) => [desc(users.createdAt)],
    });
    const [[total]] = await Promise.all([
      this.db.select({ value: count() }).from(users),
    ]);
    return { items, total: total.value, page, limit };
  }

  async setUserRole(userId: string, role: 'user' | 'admin') {
    const [updated] = await this.db
      .update(users)
      .set({ role })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw new NotFoundException('User not found');
    return updated;
  }

  // --- Project Ownership ---

  async getProjectOwners(projectId: string) {
    return this.db.query.projectOwners.findMany({
      where: eq(projectOwners.projectId, projectId),
      with: { user: true },
    });
  }

  async addProjectOwner(
    projectId: string,
    userId: string,
    role: 'owner' | 'editor' = 'editor',
  ) {
    // Verify project & user exist
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!project) throw new NotFoundException('Project not found');

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!user) throw new NotFoundException('User not found');

    // Check if already exists
    const existing = await this.db.query.projectOwners.findFirst({
      where: and(
        eq(projectOwners.projectId, projectId),
        eq(projectOwners.userId, userId),
      ),
    });

    if (existing) {
      // Update role
      const [updated] = await this.db
        .update(projectOwners)
        .set({ role })
        .where(eq(projectOwners.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await this.db
      .insert(projectOwners)
      .values({ projectId, userId, role })
      .returning();
    return created;
  }

  async removeProjectOwner(projectId: string, userId: string) {
    const [deleted] = await this.db
      .delete(projectOwners)
      .where(
        and(
          eq(projectOwners.projectId, projectId),
          eq(projectOwners.userId, userId),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException('Ownership record not found');
    return { deleted: true };
  }

  async listIndexingJobs(input: {
    status?: 'queued' | 'running' | 'completed' | 'failed';
    walletId?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const offset = (page - 1) * limit;

    const walletConditions = [] as Array<any>;
    if (input.status) walletConditions.push(eq(walletIndexingJobs.status, input.status));
    if (input.walletId) walletConditions.push(eq(walletIndexingJobs.walletId, input.walletId));
    const walletWhere =
      walletConditions.length === 0
        ? undefined
        : walletConditions.length === 1
          ? walletConditions[0]
          : and(...walletConditions);

    const generalConditions = [] as Array<any>;
    if (input.status) generalConditions.push(eq(indexingJobs.status, input.status));
    if (input.walletId) generalConditions.push(eq(indexingJobs.walletId, input.walletId));
    const generalWhere =
      generalConditions.length === 0
        ? undefined
        : generalConditions.length === 1
          ? generalConditions[0]
          : and(...generalConditions);

    const [walletItems, generalItems] = await Promise.all([
      this.db.query.walletIndexingJobs.findMany({
        where: walletWhere,
        orderBy: [desc(walletIndexingJobs.startedAt)],
      }),
      this.db.query.indexingJobs.findMany({
        where: generalWhere,
        orderBy: [desc(indexingJobs.startedAt)],
      }),
    ]);

    const combined = [
      ...walletItems.map((job) => ({
        id: job.id,
        type: job.type,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        durationMs:
          job.startedAt && job.finishedAt
            ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
            : null,
        userId: job.userId,
        walletId: job.walletId,
        statsJson: job.statsJson,
        error: job.error,
        entityType: 'wallet' as const,
        entityId: job.walletId,
      })),
      ...generalItems.map((job) => ({
        id: job.id,
        type: job.type,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        durationMs:
          job.startedAt && job.finishedAt
            ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
            : null,
        userId: job.triggeredByUserId,
        walletId: job.walletId,
        statsJson: job.statsJson,
        error: job.error,
        entityType: job.entityType,
        entityId: job.entityId,
      })),
    ].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    return {
      items: combined.slice(offset, offset + limit),
      total: combined.length,
      page,
      limit,
    };
  }

  async getIndexingJob(jobId: string) {
    const walletJob = await this.db.query.walletIndexingJobs.findFirst({
      where: eq(walletIndexingJobs.id, jobId),
    });

    if (walletJob) {
      const wallet = await this.db.query.wallets.findFirst({ where: eq(wallets.id, walletJob.walletId) });
      return {
        ...walletJob,
        entityType: 'wallet',
        entityId: walletJob.walletId,
        wallet,
        durationMs:
          walletJob.startedAt && walletJob.finishedAt
            ? new Date(walletJob.finishedAt).getTime() - new Date(walletJob.startedAt).getTime()
            : null,
      };
    }

    const job = await this.db.query.indexingJobs.findFirst({
      where: eq(indexingJobs.id, jobId),
    });

    if (!job) {
      throw new NotFoundException('Indexing job not found');
    }

    const wallet = job.walletId
      ? await this.db.query.wallets.findFirst({ where: eq(wallets.id, job.walletId) })
      : null;

    return {
      ...job,
      userId: job.triggeredByUserId,
      entityType: job.entityType,
      entityId: job.entityId,
      wallet,
      durationMs:
        job.startedAt && job.finishedAt
          ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
          : null,
    };
  }

  async retryIndexingJob(jobId: string) {
    const original = await this.db.query.walletIndexingJobs.findFirst({
      where: eq(walletIndexingJobs.id, jobId),
    });

    if (!original) {
      throw new BadRequestException('Retry is only supported for wallet indexing jobs');
    }

    const retryJob = await this.holdingsService.retryIndexingJob(jobId);
    return {
      queued: true,
      originalJobId: original.id,
      retryJobId: retryJob.id,
    };
  }

  private normalizeIndexStatus(entityType: 'wallet' | 'collection' | 'project', entity: any) {
    return {
      entityType,
      entityId: entity.id,
      lastIndexStartedAt: entity.lastIndexStartedAt ?? null,
      lastIndexFinishedAt: entity.lastIndexFinishedAt ?? null,
      lastIndexStatus: entity.lastIndexStatus ?? null,
      lastIndexError: entity.lastIndexError ?? null,
      lastIndexJobId: entity.lastIndexJobId ?? null,
    };
  }

  async getWalletIndexStatus(walletIdOrAddress: string) {
    let wallet = null;

    // Check if it looks like a UUID (8-4-4-4-12 format)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(walletIdOrAddress);
    
    if (isUuid) {
      wallet = await this.db.query.wallets.findFirst({ where: eq(wallets.id, walletIdOrAddress) });
    }
    
    if (!wallet) {
      // Try finding by address (case-sensitive for Solana, case-insensitive for EVM)
      wallet = await this.db.query.wallets.findFirst({
        where: sql`
          (${wallets.chain}::text = 'solana' AND ${wallets.address} = ${walletIdOrAddress})
          OR (${wallets.chain}::text != 'solana' AND LOWER(${wallets.address}) = ${walletIdOrAddress.toLowerCase()})
        `,
      });
    }

    if (!wallet) {
      throw new NotFoundException(`Wallet not found. Tried ${isUuid ? 'ID and ' : ''}address: ${walletIdOrAddress}`);
    }
    
    return this.normalizeIndexStatus('wallet', wallet);
  }

  async getCollectionIndexStatus(idOrContract: string) {
    const collectionId = await this.resolveCollectionId(idOrContract);
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!collection) throw new NotFoundException('Collection not found');
    return this.normalizeIndexStatus('collection', collection);
  }

  async getProjectIndexStatus(idOrSlug: string) {
    const project = await this.db.query.projects.findFirst({
      where: or(eq(projects.id, idOrSlug), eq(projects.slug, idOrSlug)),
    });

    if (!project) throw new NotFoundException('Project not found');
    return this.normalizeIndexStatus('project', project);
  }

  async refreshCollectionMetrics() {
    return this.collectionMetricsService.refreshTrackedCollectionsMetrics();
  }

  async refreshCollectionIndexing(idOrContract: string) {
    const collectionId = await this.resolveCollectionId(idOrContract);
    const response = await this.collectionMetricsService.refreshCollectionMetricsNow(collectionId);
    return {
      queued: response.queued,
      jobId: response.jobId,
      entityType: response.entityType,
      entityId: response.entityId,
    };
  }

  async refreshProjectIndexing(projectId: string) {
    const response = await this.collectionMetricsService.refreshProjectMetricsNow(projectId);
    return {
      queued: response.queued,
      jobId: response.jobId,
      entityType: response.entityType,
      entityId: response.entityId,
    };
  }

  async refreshWalletIndexing(walletIdOrAddress: string) {
    return this.holdingsService.refreshWalletIndexing(walletIdOrAddress);
  }

  async enrichCollection(idOrContract: string) {
    const collectionId = await this.resolveCollectionId(idOrContract);
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!collection) throw new NotFoundException('Collection not found');

    this.logger.log(`Enriching collection ${collectionId} (${collection.contractAddress} on ${collection.chain})`);

    // Validate contract address format before lookup
    const addr = collection.contractAddress.toLowerCase();
    if (collection.chain !== 'solana' && (!/^0x[a-f0-9]{40}$/.test(addr) || addr.length !== 42)) {
      const message = `Invalid EVM contract address format: ${collection.contractAddress} (length: ${addr.length})`;
      this.logger.error(message);
      return { success: false, message, invalidAddress: true };
    }

    const results = await this.blockchainLookup.lookup(collection.contractAddress, collection.chain);
    const metadata = results[0];

    if (!metadata) {
      this.logger.warn(`No metadata found for ${collection.contractAddress} on ${collection.chain}`);
      return { success: false, message: 'No metadata available from blockchain lookup' };
    }

    const [updated] = await this.db
      .update(collections)
      .set({
        name: metadata.name,
        imageUrl: metadata.imageUrl,
        supply: metadata.totalSupply,
        collectionType: metadata.tokenType as any,
      })
      .where(eq(collections.id, collectionId))
      .returning();

    // Also update parent project if it's an auto-generated one
    if (updated.projectId) {
      const project = await this.db.query.projects.findFirst({
        where: eq(projects.id, updated.projectId),
      });

      if (project && project.name.startsWith('Auto ')) {
        await this.db
          .update(projects)
          .set({
            name: metadata.name,
            imageUrl: metadata.imageUrl,
          })
          .where(eq(projects.id, project.id));
      }
    }

    this.logger.log(`Enriched collection ${collectionId}: ${metadata.name}`);

    return { success: true, collection: updated, metadata };
  }

  async indexCollectionHolders(idOrContract: string) {
    const collectionId = await this.resolveCollectionId(idOrContract);
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    // Mark indexing as started
    await this.db
      .update(collections)
      .set({
        lastIndexStartedAt: new Date(),
        lastIndexStatus: 'indexing',
      })
      .where(eq(collections.id, collectionId));

    // Trigger async indexing
    const result = await this.holderIndexerService.indexCollectionHolders(collectionId);

    return {
      success: result.success,
      collection: collection.name,
      holdersIndexed: result.holdersIndexed,
      error: result.error,
    };
  }

  async markCollectionAsSpam(idOrContract: string, notes?: string) {
    const collectionId = await this.resolveCollectionId(idOrContract);
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    await this.db
      .update(collections)
      .set({
        isSpam: true,
        spamScore: 100, // Manual confirmation = highest confidence
        spamReason: notes || 'manually_flagged',
        spamDetectedAt: new Date(),
        spamDetectedBy: 'manual',
      })
      .where(eq(collections.id, collectionId));

    this.logger.log(`Collection ${collectionId} (${collection.name}) marked as spam`);

    return { success: true, collection: collection.name };
  }

  async markCollectionAsNotSpam(idOrContract: string, reason: string) {
    const collectionId = await this.resolveCollectionId(idOrContract);
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    // Remove spam flag
    await this.db
      .update(collections)
      .set({
        isSpam: false,
        spamScore: 0,
        spamReason: null,
        spamDetectedAt: null,
        spamDetectedBy: null,
      })
      .where(eq(collections.id, collectionId));

    // Add to allowlist
    await this.db
      .insert(spamAllowlist)
      .values({
        collectionId,
        addedByUserId: null, // TODO: pass in admin user ID
        reason: reason || 'verified_legitimate',
      })
      .onConflictDoNothing();

    this.logger.log(`Collection ${collectionId} (${collection.name}) marked as NOT spam and added to allowlist`);

    return { success: true, collection: collection.name };
  }

  async bulkCheckSpam() {
    this.logger.log('Starting bulk spam check for all collections');
    try {
      const result = await this.spamCheckerService.checkAllCollections();
      this.logger.log(`Bulk spam check completed: ${JSON.stringify(result)}`);
      return result;
    } catch (err: any) {
      this.logger.error('Bulk spam check failed:', err.message, err.stack);
      throw err;
    }
  }

  async checkSpamRaw(idOrContract: string) {
    const collectionId = await this.resolveCollectionId(idOrContract);
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    return this.spamCheckerService.checkCollectionRaw(
      collection.chain,
      collection.contractAddress,
    );
  }

  /**
   * Discover new collections from a collection's holders (async)
   */
  async discoverCollections(
    idOrContract: string,
    options?: { maxHolders?: number; maxCollectionsPerHolder?: number }
  ) {
    const collectionId = await this.resolveCollectionId(idOrContract);

    // Run discovery in background
    setImmediate(async () => {
      try {
        await this.collectionDiscoveryService.discoverFromCollection(collectionId, options);
      } catch (err: any) {
        this.logger.error(`Collection discovery failed for ${collectionId}: ${err?.message || 'unknown error'}`);
      }
    });

    return {
      status: 'started',
      collectionId,
      message: 'Collection discovery started in background. Check server logs for progress.',
    };
  }
}
