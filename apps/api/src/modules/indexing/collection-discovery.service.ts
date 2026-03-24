import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, collections, collectionHolders } from '@nexus/database';
import { BlockchainLookupService } from '../search/blockchain-lookup.service';

interface DiscoveryResult {
  collectionId: string;
  collectionName: string;
  holdersChecked: number;
  newCollectionsFound: number;
  newCollections: Array<{
    chain: string;
    contractAddress: string;
    name: string;
  }>;
  processingTimeMs: number;
}

@Injectable()
export class CollectionDiscoveryService {
  private readonly logger = new Logger(CollectionDiscoveryService.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly blockchainLookup: BlockchainLookupService,
  ) {}

  /**
   * Discover new collections by analyzing what holders of a given collection own
   */
  async discoverFromCollection(
    collectionId: string,
    options?: {
      maxHolders?: number;
      maxCollectionsPerHolder?: number;
    }
  ): Promise<DiscoveryResult> {
    const startTime = Date.now();
    const maxHolders = options?.maxHolders || 100;
    const maxPerHolder = options?.maxCollectionsPerHolder || 50;

    this.logger.log(`Starting collection discovery for ${collectionId}`);

    // Get the source collection
    const sourceCollection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!sourceCollection) {
      throw new Error('Collection not found');
    }

    // Get sample of holders
    const holdersResult = await this.db.execute<{ address: string; chain: string }>(
      sql`
        SELECT DISTINCT address, chain
        FROM collection_holders
        WHERE collection_id = ${collectionId}
        LIMIT ${maxHolders}
      `
    );

    this.logger.log(`Checking ${holdersResult.length} holders for new collections`);

    const discoveredContracts = new Map<string, { chain: string; address: string }>();
    let holdersChecked = 0;

    // Check each holder's other NFTs
    for (const holder of holdersResult) {
      try {
        holdersChecked++;
        
        // Query blockchain for this holder's NFTs
        const nfts = await this.blockchainLookup.getHolderNFTs(
          holder.chain,
          holder.address,
          maxPerHolder
        );

        // Check which contracts we haven't seen before
        for (const nft of nfts) {
          // Preserve case for Solana (base58), lowercase for EVM (hex)
          const normalizedAddress = nft.chain === 'solana' 
            ? nft.contractAddress 
            : nft.contractAddress.toLowerCase();
          const key = `${nft.chain}:${normalizedAddress}`;
          
          if (discoveredContracts.has(key)) continue;
          
          // Check if already in our DB
          const existsResult = await this.db.execute(sql`
            SELECT id FROM collections 
            WHERE chain = ${nft.chain} 
              AND CASE 
                WHEN chain = 'solana' THEN contract_address = ${normalizedAddress}
                ELSE LOWER(contract_address) = ${normalizedAddress}
              END
            LIMIT 1
          `);
          const exists = existsResult.length > 0;

          if (!exists) {
            discoveredContracts.set(key, {
              chain: nft.chain,
              address: normalizedAddress,
            });
          }
        }

        if (holdersChecked % 10 === 0) {
          this.logger.log(`Progress: ${holdersChecked}/${holdersResult.length} holders checked, ${discoveredContracts.size} new collections found`);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to check holder ${holder.address}: ${err?.message || 'unknown error'}`);
      }
    }

    // Add discovered collections to database
    const newCollections: Array<{ chain: string; contractAddress: string; name: string }> = [];
    
    for (const [key, contract] of discoveredContracts) {
      try {
        // Fetch metadata
        const metadata = await this.blockchainLookup.getContractMetadata(
          contract.chain,
          contract.address
        );

        // Add to database as unverified
        const collectionType = metadata?.tokenType?.toLowerCase() === 'erc1155' ? 'erc1155' : 'erc721';
        const name = metadata?.name || `${contract.chain}:${contract.address.slice(0, 8)}...`;
        
        await this.db.execute(sql`
          INSERT INTO collections (chain, contract_address, name, image_url, collection_type, verification_status, mapping_status, last_seen_at)
          VALUES (${contract.chain}, ${contract.address}, ${name}, 
                  ${metadata?.imageUrl || null}, ${collectionType}, 
                  'tracked_unverified', 'unmapped', NOW())
          ON CONFLICT (chain, contract_address) DO NOTHING
        `);

        newCollections.push({
          chain: contract.chain,
          contractAddress: contract.address,
          name: name,
        });

        this.logger.log(`Added new collection: ${metadata?.name || contract.address}`);
      } catch (err: any) {
        this.logger.error(`Failed to add collection ${contract.address}: ${err?.message || 'unknown error'}`);
      }
    }

    const processingTime = Date.now() - startTime;

    this.logger.log(
      `Discovery complete: ${newCollections.length} new collections added in ${processingTime}ms`
    );

    return {
      collectionId: sourceCollection.id,
      collectionName: sourceCollection.name,
      holdersChecked,
      newCollectionsFound: newCollections.length,
      newCollections,
      processingTimeMs: processingTime,
    };
  }
}
