import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
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

  /**
   * Get network graph data showing collection overlaps
   * Returns nodes (collections) and edges (shared holders)
   */
  async getNetworkGraph(options?: {
    minSharedHolders?: number;
    maxNodes?: number;
    chains?: string[];
  }) {
    const minShared = options?.minSharedHolders || 5;
    const maxNodes = options?.maxNodes || 50;
    const chains = options?.chains || [];

    try {
      // Get collections with indexed holders
      const collectionsResult = await this.db.execute(
        sql.raw(`
          SELECT DISTINCT c.id, c.name, c.chain, c.contract_address, c.image_url, COUNT(ch.address) as holder_count
          FROM collections c
          INNER JOIN collection_holders ch ON ch.collection_id = c.id
          WHERE c.is_spam = false
          ${chains.length > 0 ? `AND c.chain = ANY(ARRAY[${chains.map((c) => `'${c}'`).join(',')}])` : ''}
          GROUP BY c.id
          HAVING COUNT(ch.address) > 0
          ORDER BY holder_count DESC
          LIMIT ${maxNodes}
        `),
      );

    const nodes = collectionsResult.map((row: any) => ({
      id: row.id,
      name: row.name,
      chain: row.chain,
      contractAddress: row.contract_address,
      imageUrl: row.image_url,
      holderCount: parseInt(row.holder_count),
    }));

    const collectionIds = nodes.map((n) => n.id);

    if (collectionIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Get overlap edges
    const edgesResult = await this.db.execute(
      sql.raw(`
        SELECT 
          a.collection_id as source_id,
          b.collection_id as target_id,
          COUNT(DISTINCT a.address) as shared_holders
        FROM collection_holders a
        INNER JOIN collection_holders b 
          ON a.address = b.address 
          AND a.chain = b.chain
          AND a.collection_id < b.collection_id
        WHERE a.collection_id = ANY(ARRAY['${collectionIds.join("','")}']::uuid[])
          AND b.collection_id = ANY(ARRAY['${collectionIds.join("','")}']::uuid[])
        GROUP BY a.collection_id, b.collection_id
        HAVING COUNT(DISTINCT a.address) >= ${minShared}
        ORDER BY shared_holders DESC
      `),
    );

    const edges = edgesResult.map((row: any) => {
      const sharedHolders = parseInt(row.shared_holders);
      const sourceNode = nodes.find((n) => n.id === row.source_id);
      const targetNode = nodes.find((n) => n.id === row.target_id);
      
      // Weight by percentage of smaller collection
      const smallerCount = Math.min(
        sourceNode?.holderCount || 1,
        targetNode?.holderCount || 1,
      );
      const weight = Math.min(sharedHolders / smallerCount, 1);

      return {
        source: row.source_id,
        target: row.target_id,
        sharedHolders,
        weight,
      };
    });

      return { nodes, edges };
    } catch (error) {
      console.error('Error generating network graph:', error);
      // Return empty graph on error rather than crashing
      return { nodes: [], edges: [] };
    }
  }

  /**
   * Get personalized collection recommendations based on user's holdings
   */
  async getRecommendations(userAddress: string, chain: string, options?: {
    limit?: number;
    minOverlap?: number;
  }) {
    try {
      const limit = options?.limit || 10;
      const minOverlap = options?.minOverlap || 3;

      // Get collections user already holds
      const userCollections = await this.db.execute(
        sql.raw(`
          SELECT DISTINCT ch.collection_id, c.name
          FROM collection_holders ch
          INNER JOIN collections c ON c.id = ch.collection_id
          WHERE ch.address = '${userAddress.toLowerCase()}' 
            AND ch.chain = '${chain}' 
            AND c.is_spam = false
        `),
      );

      const userCollectionIds = userCollections.map((row: any) => row.collection_id);

      if (userCollectionIds.length === 0) {
        return []; // User doesn't hold any indexed collections
      }

    // Find collections with high holder overlap (simplified)
    const recommendations = await this.db.execute(
      sql.raw(`
        SELECT 
          c.id,
          c.name,
          c.chain,
          c.contract_address,
          c.image_url,
          c.floor_price,
          COUNT(DISTINCT ch.address) as holder_count,
          COUNT(DISTINCT ch2.address) as shared_holders
        FROM collections c
        INNER JOIN collection_holders ch ON ch.collection_id = c.id
        INNER JOIN collection_holders ch2 
          ON ch2.address = ch.address
          AND ch2.chain = ch.chain
          AND ch2.collection_id = ANY(ARRAY['${userCollectionIds.join("','")}']::uuid[])
        WHERE c.is_spam = false
          AND c.id != ALL(ARRAY['${userCollectionIds.join("','")}']::uuid[])
          AND ch.chain = '${chain}'
        GROUP BY c.id
        HAVING COUNT(DISTINCT ch2.address) >= ${minOverlap}
        ORDER BY shared_holders DESC, holder_count DESC
        LIMIT ${limit}
      `),
    );

      return recommendations.map((row: any) => {
        const sharedHolders = parseInt(row.shared_holders);
        const holderCount = parseInt(row.holder_count) || 1;
        const score = Math.min(sharedHolders / holderCount, 1);

        const basedOnCollections = userCollections
          .filter((uc: any) => userCollectionIds.includes(uc.collection_id))
          .map((uc: any) => ({
            id: uc.collection_id,
            name: uc.name,
            overlap: Math.floor(sharedHolders / userCollectionIds.length),
          }));

        return {
          collection: {
            id: row.id,
            name: row.name,
            chain: row.chain,
            contractAddress: row.contract_address,
            imageUrl: row.image_url,
            holderCount,
            floorPrice: row.floor_price ? parseFloat(row.floor_price) : null,
          },
          score,
          sharedHolders,
          basedOn: basedOnCollections,
          reason: `${sharedHolders} collectors from your communities also hold this`,
        };
      });
    } catch (error) {
      console.error('Error generating recommendations:', error);
      return [];
    }
  }
}
