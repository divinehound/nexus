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

interface CachedNetworkGraph {
  data: { nodes: any[]; edges: any[] };
  timestamp: number;
  ttl: number;
}

@Injectable()
export class CollectionsService {
  private networkGraphCache = new Map<string, CachedNetworkGraph>();
  private readonly DEFAULT_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly collectionMetricsService: CollectionMetricsService,
  ) {}

  /**
   * Generate cache key for network graph
   */
  private getNetworkGraphCacheKey(options: {
    strategy?: string;
    chains?: string[];
    maxNodes?: number;
    minSharedHolders?: number;
    focusCollectionId?: string;
  }): string {
    const { strategy = 'top-collections', chains = [], maxNodes = 50, minSharedHolders = 5, focusCollectionId } = options;
    const chainKey = chains.sort().join(',') || 'all';
    const focusKey = focusCollectionId || 'global';
    return `${strategy}_${chainKey}_${maxNodes}_${minSharedHolders}_${focusKey}`;
  }

  /**
   * Get cached network graph if valid
   */
  private getCachedNetworkGraph(cacheKey: string): { nodes: any[]; edges: any[] } | null {
    const cached = this.networkGraphCache.get(cacheKey);
    if (!cached) return null;

    const now = Date.now();
    if (now - cached.timestamp > cached.ttl) {
      this.networkGraphCache.delete(cacheKey);
      return null;
    }

    return cached.data;
  }

  /**
   * Cache network graph result
   */
  private cacheNetworkGraph(cacheKey: string, data: { nodes: any[]; edges: any[] }, ttl?: number): void {
    this.networkGraphCache.set(cacheKey, {
      data,
      timestamp: Date.now(),
      ttl: ttl || this.DEFAULT_CACHE_TTL,
    });
  }

  /**
   * Clear network graph cache (call when collections re-indexed)
   */
  clearNetworkGraphCache(): void {
    this.networkGraphCache.clear();
  }

  /**
   * Build network graph via BFS traversal from seed nodes
   */
  private async buildConnectedTraverse(options: {
    maxNodes: number;
    minSharedHolders: number;
    chains: string[];
  }): Promise<{ collectionIds: string[]; collectionMap: Map<string, any> }> {
    const { maxNodes, minSharedHolders, chains } = options;
    const visited = new Set<string>();
    const collectionMap = new Map<string, any>();
    const queue: { id: string; depth: number }[] = [];

    // Step 1: Get seed nodes (top collections per chain or overall)
    const seedsPerChain = Math.max(3, Math.floor(maxNodes / 10));
    const seedsResult = await this.db.execute(
      chains.length > 0
        ? sql`
            (SELECT DISTINCT c.id, c.name, c.chain, c.contract_address, c.image_url, COUNT(ch.address) as holder_count
             FROM collections c
             INNER JOIN collection_holders ch ON ch.collection_id = c.id
             WHERE c.is_spam = false AND c.chain IN (${sql.join(chains.map(chain => sql`${chain}`), sql`, `)})
             GROUP BY c.id, c.chain
             HAVING COUNT(ch.address) > 0
             ORDER BY holder_count DESC
             LIMIT ${seedsPerChain})
          `
        : sql`
            SELECT DISTINCT c.id, c.name, c.chain, c.contract_address, c.image_url, COUNT(ch.address) as holder_count
            FROM collections c
            INNER JOIN collection_holders ch ON ch.collection_id = c.id
            WHERE c.is_spam = false
            GROUP BY c.id
            HAVING COUNT(ch.address) > 0
            ORDER BY holder_count DESC
            LIMIT ${seedsPerChain}
          `,
    );

    // Add seeds to queue and map
    for (const row of seedsResult) {
      const id = row.id as string;
      visited.add(id);
      collectionMap.set(id, {
        id,
        name: row.name,
        chain: row.chain,
        contractAddress: row.contract_address,
        imageUrl: row.image_url,
        holderCount: parseInt(row.holder_count as string),
      });
      queue.push({ id, depth: 0 });
    }

    // Step 2: BFS traverse to find connected collections
    while (queue.length > 0 && collectionMap.size < maxNodes) {
      const { id, depth } = queue.shift()!;
      
      // Limit depth to prevent exponential explosion
      if (depth >= 2) continue;
      
      // Get related collections for this node
      const related = await this.getRelatedCollections(id, 10);
      
      // Determine how many to add based on depth
      const limitAtDepth = depth === 0 ? 10 : 5;
      
      for (const rel of related.slice(0, limitAtDepth)) {
        if (collectionMap.size >= maxNodes) break;
        if (visited.has(rel.id)) continue;
        if (rel.sharedHolders < minSharedHolders) continue;
        
        visited.add(rel.id);
        collectionMap.set(rel.id, {
          id: rel.id,
          name: rel.name,
          chain: rel.chain,
          contractAddress: rel.contractAddress,
          imageUrl: rel.imageUrl,
          holderCount: rel.totalHolders,
        });
        queue.push({ id: rel.id, depth: depth + 1 });
      }
    }

    return { collectionIds: Array.from(visited), collectionMap };
  }

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
    // Multi-wallet aware: addresses linked to same user = same holder
    const result = await this.db.execute<any>(sql`
      WITH target_holder_groups AS (
        -- Group target collection holders by user or address
        -- Case-sensitive for Solana, case-insensitive for EVM
        SELECT DISTINCT
          COALESCE(
            w.user_id::text,
            CASE 
              WHEN ch.chain = 'solana' THEN ch.address
              ELSE LOWER(ch.address)
            END
          ) as holder_id
        FROM collection_holders ch
        LEFT JOIN wallets w ON 
          CASE
            WHEN ch.chain = 'solana' THEN w.address = ch.address
            ELSE LOWER(w.address) = LOWER(ch.address)
          END
          AND w.chain::text = ch.chain
        WHERE ch.collection_id = ${collectionId}
      ),
      other_holder_groups AS (
        -- Group all collection holders by user or address
        SELECT 
          ch.collection_id,
          COALESCE(
            w.user_id::text,
            CASE 
              WHEN ch.chain = 'solana' THEN ch.address
              ELSE LOWER(ch.address)
            END
          ) as holder_id
        FROM collection_holders ch
        LEFT JOIN wallets w ON 
          CASE
            WHEN ch.chain = 'solana' THEN w.address = ch.address
            ELSE LOWER(w.address) = LOWER(ch.address)
          END
          AND w.chain::text = ch.chain
        WHERE ch.collection_id != ${collectionId}
      ),
      other_collection_holders AS (
        SELECT 
          ohg.collection_id,
          COUNT(DISTINCT ohg.holder_id) as shared_holders
        FROM other_holder_groups ohg
        INNER JOIN target_holder_groups thg ON ohg.holder_id = thg.holder_id
        GROUP BY ohg.collection_id
      ),
      total_collection_holders AS (
        SELECT 
          collection_id,
          COUNT(DISTINCT holder_id) as total_holders
        FROM other_holder_groups
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
           (SELECT COUNT(*) FROM target_holder_groups)::numeric) * 100, 
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
    strategy?: 'top-collections' | 'connected-traverse';
    minSharedHolders?: number;
    maxNodes?: number;
    chains?: string[];
    focusCollectionId?: string;
  }) {
    const strategy = options?.strategy || 'connected-traverse';
    const minShared = options?.minSharedHolders || 5;
    const maxNodes = options?.maxNodes || 50;
    const chains = options?.chains || [];
    const focusId = options?.focusCollectionId;

    // Check cache first
    const cacheKey = this.getNetworkGraphCacheKey({ strategy, chains, maxNodes, minSharedHolders: minShared, focusCollectionId: focusId });
    const cached = this.getCachedNetworkGraph(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      let nodes: any[];
      let collectionMap: Map<string, any> | undefined;
      
      if (focusId) {
        // Focus mode: get the focused collection + its related collections
        const focusedCollection = await this.db.query.collections.findFirst({
          where: eq(collections.id, focusId),
        });
        
        if (!focusedCollection) {
          return { nodes: [], edges: [] };
        }
        
        const related = await this.getRelatedCollections(focusId, maxNodes - 1);
        
        // Include the focused collection itself
        nodes = [
          {
            id: focusedCollection.id,
            name: focusedCollection.name,
            chain: focusedCollection.chain,
            contractAddress: focusedCollection.contractAddress,
            imageUrl: focusedCollection.imageUrl,
            holderCount: focusedCollection.holderCount || 0,
          },
          ...related.map((r: any) => ({
            id: r.id,
            name: r.name,
            chain: r.chain,
            contractAddress: r.contractAddress,
            imageUrl: r.imageUrl,
            holderCount: r.totalHolders,
          })),
        ];
      } else if (strategy === 'connected-traverse') {
        // Connected traverse strategy: BFS from seed nodes
        const traverseResult = await this.buildConnectedTraverse({
          maxNodes,
          minSharedHolders: minShared,
          chains,
        });
        
        collectionMap = traverseResult.collectionMap;
        nodes = Array.from(collectionMap.values());
      } else {
        // Top collections strategy: top N by holder count
        const collectionsResult = await this.db.execute(
          chains.length > 0
            ? sql`
                SELECT DISTINCT c.id, c.name, c.chain, c.contract_address, c.image_url, COUNT(ch.address) as holder_count
                FROM collections c
                INNER JOIN collection_holders ch ON ch.collection_id = c.id
                WHERE c.is_spam = false AND c.chain IN (${sql.join(chains.map(chain => sql`${chain}`), sql`, `)})
                GROUP BY c.id
                HAVING COUNT(ch.address) > 0
                ORDER BY holder_count DESC
                LIMIT ${maxNodes}
              `
            : sql`
                SELECT DISTINCT c.id, c.name, c.chain, c.contract_address, c.image_url, COUNT(ch.address) as holder_count
                FROM collections c
                INNER JOIN collection_holders ch ON ch.collection_id = c.id
                WHERE c.is_spam = false
                GROUP BY c.id
                HAVING COUNT(ch.address) > 0
                ORDER BY holder_count DESC
                LIMIT ${maxNodes}
              `,
        );

        nodes = collectionsResult.map((row: any) => ({
          id: row.id,
          name: row.name,
          chain: row.chain,
          contractAddress: row.contract_address,
          imageUrl: row.image_url,
          holderCount: parseInt(row.holder_count),
        }));
      }

    const collectionIds = nodes.map((n) => n.id);

    if (collectionIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Get overlap edges (cross-chain + multi-wallet aware)
    // Same address OR addresses linked to same user = same holder
    // Case-sensitive for Solana, case-insensitive for EVM
    const edgesResult = await this.db.execute(
      sql`
        WITH holder_groups AS (
          SELECT 
            ch.collection_id,
            COALESCE(
              w.user_id::text,
              CASE 
                WHEN ch.chain = 'solana' THEN ch.address
                ELSE LOWER(ch.address)
              END
            ) as holder_id
          FROM collection_holders ch
          LEFT JOIN wallets w ON 
            CASE
              WHEN ch.chain = 'solana' THEN w.address = ch.address
              ELSE LOWER(w.address) = LOWER(ch.address)
            END
            AND w.chain::text = ch.chain
          WHERE ch.collection_id IN (${sql.join(collectionIds.map(id => sql`${id}`), sql`, `)})
        )
        SELECT 
          a.collection_id as source_id,
          b.collection_id as target_id,
          COUNT(DISTINCT a.holder_id) as shared_holders
        FROM holder_groups a
        INNER JOIN holder_groups b 
          ON a.holder_id = b.holder_id
          AND a.collection_id < b.collection_id
        GROUP BY a.collection_id, b.collection_id
        HAVING COUNT(DISTINCT a.holder_id) >= ${minShared}
        ORDER BY shared_holders DESC
      `,
    );

    const edges = edgesResult.map((row: any) => {
      const sharedHolders = parseInt(row.shared_holders);
      const sourceNode = nodes.find((n) => n.id === row.source_id);
      const targetNode = nodes.find((n) => n.id === row.target_id);
      
      // Weight by percentage of smaller collection
      // BUT: if indexed holder count < shared holders (data incomplete), use normalized absolute count
      const sourceCount = sourceNode?.holderCount || 0;
      const targetCount = targetNode?.holderCount || 0;
      const smallerCount = Math.min(sourceCount, targetCount);
      
      let weight: number;
      if (smallerCount < sharedHolders) {
        // Data issue: indexed holders < shared (shouldn't happen, but Solana data may be incomplete)
        // Fallback: normalize by shared holders (0-1 scale based on max seen)
        weight = Math.min(sharedHolders / 100, 1); // Arbitrary scale
      } else if (smallerCount === 0) {
        // No holder data: weight by absolute count only
        weight = Math.min(sharedHolders / 100, 1);
      } else {
        // Normal case: percentage of smaller collection
        weight = Math.min(sharedHolders / smallerCount, 1);
      }

      return {
        source: row.source_id,
        target: row.target_id,
        sharedHolders,
        weight,
        holderDataReliable: smallerCount >= sharedHolders && smallerCount > 0,
      };
    });

      const result = { nodes, edges };
      
      // Cache the result
      this.cacheNetworkGraph(cacheKey, result);
      
      return result;
    } catch (error) {
      console.error('Error generating network graph:', error);
      // Return empty graph on error rather than crashing
      return { nodes: [], edges: [] };
    }
  }

  /**
   * Get connections for a specific collection (for incremental graph building)
   * Returns the source collection + connected collections + edges between them
   */
  async getCollectionConnections(collectionId: string, options?: {
    minSharedHolders?: number;
    limit?: number;
  }) {
    const minShared = options?.minSharedHolders || 5;
    const limit = options?.limit || 10;

    try {
      // Get the source collection
      const sourceCollection = await this.db.query.collections.findFirst({
        where: eq(collections.id, collectionId),
      });

      if (!sourceCollection) {
        return { nodes: [], edges: [] };
      }

      // Get related collections
      const related = await this.getRelatedCollections(collectionId, limit);
      
      // Filter by minSharedHolders
      const filteredRelated = related.filter(r => r.sharedHolders >= minShared);

      // Build nodes array (source + related)
      const nodes = [
        {
          id: sourceCollection.id,
          name: sourceCollection.name,
          chain: sourceCollection.chain,
          contractAddress: sourceCollection.contractAddress,
          imageUrl: sourceCollection.imageUrl,
          holderCount: sourceCollection.holderCount || 0,
        },
        ...filteredRelated.map(r => ({
          id: r.id,
          name: r.name,
          chain: r.chain,
          contractAddress: r.contractAddress,
          imageUrl: r.imageUrl,
          holderCount: r.totalHolders,
        })),
      ];

      // Build edges array (source → related connections)
      const edges = filteredRelated.map(r => {
        const smallerCount = Math.min(sourceCollection.holderCount || 0, r.totalHolders);
        const weight = smallerCount > 0 ? Math.min(r.sharedHolders / smallerCount, 1) : 0;
        
        return {
          source: collectionId,
          target: r.id,
          sharedHolders: r.sharedHolders,
          weight,
          holderDataReliable: smallerCount >= r.sharedHolders && smallerCount > 0,
        };
      });

      // Also check for edges BETWEEN the related collections (if they overlap with each other)
      if (filteredRelated.length > 1) {
        const relatedIds = filteredRelated.map(r => r.id);
        const crossEdgesResult = await this.db.execute(
          sql`
            WITH holder_groups AS (
              SELECT 
                ch.collection_id,
                COALESCE(
                  w.user_id::text,
                  CASE 
                    WHEN ch.chain = 'solana' THEN ch.address
                    ELSE LOWER(ch.address)
                  END
                ) as holder_id
              FROM collection_holders ch
              LEFT JOIN wallets w ON 
                CASE
                  WHEN ch.chain = 'solana' THEN w.address = ch.address
                  ELSE LOWER(w.address) = LOWER(ch.address)
                END
                AND w.chain::text = ch.chain
              WHERE ch.collection_id IN (${sql.join(relatedIds.map(id => sql`${id}`), sql`, `)})
            )
            SELECT 
              a.collection_id as source_id,
              b.collection_id as target_id,
              COUNT(DISTINCT a.holder_id) as shared_holders
            FROM holder_groups a
            INNER JOIN holder_groups b 
              ON a.holder_id = b.holder_id
              AND a.collection_id < b.collection_id
            GROUP BY a.collection_id, b.collection_id
            HAVING COUNT(DISTINCT a.holder_id) >= ${minShared}
          `,
        );

        // Add cross edges
        for (const row of crossEdgesResult) {
          const sharedHolders = parseInt(row.shared_holders as string);
          const sourceNode = nodes.find(n => n.id === row.source_id);
          const targetNode = nodes.find(n => n.id === row.target_id);
          
          if (sourceNode && targetNode) {
            const smallerCount = Math.min(sourceNode.holderCount, targetNode.holderCount);
            const weight = smallerCount > 0 ? Math.min(sharedHolders / smallerCount, 1) : 0;
            
            edges.push({
              source: row.source_id as string,
              target: row.target_id as string,
              sharedHolders,
              weight,
              holderDataReliable: smallerCount >= sharedHolders && smallerCount > 0,
            });
          }
        }
      }

      return { nodes, edges };
    } catch (error) {
      console.error('Error fetching collection connections:', error);
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
      // Case-sensitive for Solana, case-insensitive for EVM
      const normalizedAddress = chain === 'solana' ? userAddress : userAddress.toLowerCase();
      const userCollections = await this.db.execute(
        sql`
          SELECT DISTINCT ch.collection_id, c.name
          FROM collection_holders ch
          INNER JOIN collections c ON c.id = ch.collection_id
          WHERE ch.address = ${normalizedAddress}
            AND ch.chain = ${chain}
            AND c.is_spam = false
        `,
      );

      const userCollectionIds = userCollections.map((row: any) => row.collection_id);

      if (userCollectionIds.length === 0) {
        return []; // User doesn't hold any indexed collections
      }

    // Find collections with high holder overlap (cross-chain + multi-wallet aware)
    // Addresses linked to same user = same holder
    // Case-sensitive for Solana, case-insensitive for EVM
    const recommendations = await this.db.execute(
      sql`
        WITH user_holder_groups AS (
          SELECT DISTINCT
            COALESCE(
              w.user_id::text,
              CASE 
                WHEN ch.chain = 'solana' THEN ch.address
                ELSE LOWER(ch.address)
              END
            ) as holder_id
          FROM collection_holders ch
          LEFT JOIN wallets w ON 
            CASE
              WHEN ch.chain = 'solana' THEN w.address = ch.address
              ELSE LOWER(w.address) = LOWER(ch.address)
            END
            AND w.chain::text = ch.chain
          WHERE ch.collection_id IN (${sql.join(userCollectionIds.map(id => sql`${id}`), sql`, `)})
        ),
        all_holder_groups AS (
          SELECT 
            ch.collection_id,
            COALESCE(
              w.user_id::text,
              CASE 
                WHEN ch.chain = 'solana' THEN ch.address
                ELSE LOWER(ch.address)
              END
            ) as holder_id
          FROM collection_holders ch
          LEFT JOIN wallets w ON 
            CASE
              WHEN ch.chain = 'solana' THEN w.address = ch.address
              ELSE LOWER(w.address) = LOWER(ch.address)
            END
            AND w.chain::text = ch.chain
        )
        SELECT 
          c.id,
          c.name,
          c.chain,
          c.contract_address,
          c.image_url,
          c.floor_price,
          COUNT(DISTINCT ahg.holder_id) as holder_count,
          COUNT(DISTINCT CASE WHEN uhg.holder_id IS NOT NULL THEN ahg.holder_id END) as shared_holders
        FROM collections c
        INNER JOIN all_holder_groups ahg ON ahg.collection_id = c.id
        LEFT JOIN user_holder_groups uhg ON uhg.holder_id = ahg.holder_id
        WHERE c.is_spam = false
          AND c.id NOT IN (${sql.join(userCollectionIds.map(id => sql`${id}`), sql`, `)})
        GROUP BY c.id
        HAVING COUNT(DISTINCT CASE WHEN uhg.holder_id IS NOT NULL THEN ahg.holder_id END) >= ${minOverlap}
        ORDER BY shared_holders DESC, holder_count DESC
        LIMIT ${limit}
      `,
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
