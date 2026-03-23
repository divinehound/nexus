import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  type Database,
  collections,
  collectionIntakeRequests,
  projects,
} from '@nexus/database';
import { CollectionMetricsService } from './collection-metrics.service';

const SUPPORTED_CHAINS = [
  'ethereum',
  'base',
  'abstract',
  'apechain',
  'polygon',
  'solana',
] as const;

type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

@Injectable()
export class CollectionsService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly collectionMetricsService: CollectionMetricsService,
  ) {}

  async findById(id: string) {
    return this.db.query.collections.findFirst({
      where: eq(collections.id, id),
      with: { project: true, marketSnapshots: true, proposedProject: true },
    });
  }

  async findByAddress(address: string) {
    return this.db.query.collections.findFirst({
      where: eq(collections.contractAddress, address),
      with: { project: true, proposedProject: true },
    });
  }

  async trackCollection(input: { chain: string; contractAddress: string }) {
    const chain = this.validateChain(input.chain);
    const normalizedAddress = this.normalizeAndValidateAddress(
      chain,
      input.contractAddress,
    );

    const intakeProjectId = await this.ensureUnassignedProject();

    const [trackedCollection] = await this.db
      .insert(collections)
      .values({
        projectId: intakeProjectId,
        chain,
        contractAddress: normalizedAddress,
        name: this.defaultCollectionName(chain, normalizedAddress),
        collectionType: chain === 'solana' ? 'spl' : 'erc721',
        verificationStatus: 'tracked_unverified',
        mappingStatus: 'unmapped',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [collections.chain, collections.contractAddress],
        set: {
          lastSeenAt: new Date(),
          verificationStatus: 'tracked_unverified',
        },
      })
      .returning();

    await this.db.insert(collectionIntakeRequests).values({
      chain,
      contractAddress: normalizedAddress,
      source: 'api',
      status: 'queued',
    });

    const indexing = await this.collectionMetricsService.refreshCollectionMetricsNow(
      trackedCollection.id,
    );

    return {
      collectionId: trackedCollection.id,
      status: trackedCollection.verificationStatus,
      routeHint: `/api/collections/${chain}/${normalizedAddress}`,
      indexing: {
        queued: indexing.queued,
        deduped: indexing.deduped,
        jobId: indexing.jobId,
      },
    };
  }

  async findByChainAndContract(chainInput: string, contractAddressInput: string) {
    const chain = this.validateChain(chainInput);
    const contractAddress = this.normalizeAndValidateAddress(
      chain,
      contractAddressInput,
    );

    const collection = await this.db.query.collections.findFirst({
      where: and(
        eq(collections.chain, chain),
        eq(collections.contractAddress, contractAddress),
      ),
      with: {
        project: true,
        proposedProject: true,
      },
    });

    if (!collection) {
      throw new NotFoundException({
        error: 'NOT_FOUND',
        message: 'Collection not tracked',
      });
    }

    return {
      id: collection.id,
      chain: collection.chain,
      contractAddress: collection.contractAddress,
      name: collection.name,
      imageUrl: collection.imageUrl,
      collectionType: collection.collectionType,
      verificationStatus: collection.verificationStatus,
      mappingStatus: collection.mappingStatus,
      verificationNotes: collection.verificationNotes,
      mappingConfidence:
        collection.mappingConfidence === null
          ? null
          : Number(collection.mappingConfidence),
      firstSeenAt: collection.firstSeenAt,
      lastSeenAt: collection.lastSeenAt,
      project: collection.project
        ? {
            id: collection.project.id,
            name: collection.project.name,
            slug: collection.project.slug,
            isVerified: collection.project.isVerified,
          }
        : null,
      proposedProject: collection.proposedProject
        ? {
            id: collection.proposedProject.id,
            name: collection.proposedProject.name,
            slug: collection.proposedProject.slug,
            isVerified: collection.proposedProject.isVerified,
          }
        : null,
      metrics: {
        floorPrice: collection.floorPrice,
        holderCount: collection.holderCount,
        listedCount: collection.listedCount,
        volume24h: null,
      },
    };
  }

  validateChain(chain: string): SupportedChain {
    if (!SUPPORTED_CHAINS.includes(chain as SupportedChain)) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `Unsupported chain: ${chain}`,
      });
    }
    return chain as SupportedChain;
  }

  normalizeAndValidateAddress(chain: SupportedChain, address: string): string {
    const value = address?.trim();
    if (!value) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'contractAddress is required',
      });
    }

    if (chain === 'solana') {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
        throw new BadRequestException({
          error: 'VALIDATION_ERROR',
          message: 'Invalid Solana contract address',
        });
      }
      return value;
    }

    const normalized = value.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'Invalid EVM contract address',
      });
    }
    return normalized;
  }

  private defaultCollectionName(chain: SupportedChain, address: string): string {
    return `${chain}:${address.slice(0, 8)}...`;
  }

  private async ensureUnassignedProject(): Promise<string> {
    const slug = 'unassigned-contract-intake';

    const existing = await this.db.query.projects.findFirst({
      where: eq(projects.slug, slug),
    });
    if (existing) return existing.id;

    const [created] = await this.db
      .insert(projects)
      .values({
        name: 'Unassigned Contract Intake',
        slug,
        description:
          'Auto-generated placeholder project for contract-first intake before project mapping.',
        isVerified: false,
      })
      .returning();

    return created.id;
  }

  async getRelatedCollections(collectionId: string, limit: number = 10) {
    // SQL query to find collections with overlapping holders
    // Uses collection_holders table (full blockchain data, not limited to NEXUS users)
    const result = await this.db.execute<any>(/* sql */ `
      WITH target_holders AS (
        SELECT DISTINCT address
        FROM collection_holders
        WHERE collection_id = ${collectionId}
      ),
      other_collection_holders AS (
        SELECT 
          ch.collection_id,
          COUNT(DISTINCT ch.address) as shared_holders
        FROM collection_holders ch
        INNER JOIN target_holders th ON ch.address = th.address
        WHERE ch.collection_id != ${collectionId}
        GROUP BY ch.collection_id
      ),
      total_collection_holders AS (
        SELECT 
          collection_id,
          COUNT(DISTINCT address) as total_holders
        FROM collection_holders
        WHERE collection_id IN (SELECT collection_id FROM other_collection_holders)
        GROUP BY collection_id
      )
      SELECT 
        c.id,
        c.name,
        c.contract_address,
        c.chain,
        c.image_url,
        och.shared_holders::text,
        tch.total_holders::text,
        ROUND(
          (och.shared_holders::numeric / 
           (SELECT COUNT(DISTINCT address) FROM target_holders)::numeric) * 100, 
          1
        )::text as overlap_percentage
      FROM other_collection_holders och
      INNER JOIN total_collection_holders tch ON och.collection_id = tch.collection_id
      INNER JOIN collections c ON och.collection_id = c.id
      ORDER BY och.shared_holders DESC, overlap_percentage DESC
      LIMIT ${limit}
    `);

    return result.map((row: any) => ({
      id: row.id,
      name: row.name,
      contractAddress: row.contract_address,
      chain: row.chain,
      imageUrl: row.image_url,
      sharedHolders: parseInt(row.shared_holders),
      totalHolders: parseInt(row.total_holders),
      overlapPercentage: parseFloat(row.overlap_percentage),
    }));
  }
}
