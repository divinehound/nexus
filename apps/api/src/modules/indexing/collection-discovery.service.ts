import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, collections, collectionHolders } from '@nexus/database';
import { BlockchainLookupService } from '../search/blockchain-lookup.service';
import { SpamCheckerService } from './spam-checker.service';

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
    private readonly spamChecker: SpamCheckerService,
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
    const maxHolders = options?.maxHolders || 500; // Increased from 100 to 500
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

    // Log what we're about to process BEFORE we start
    const totalContracts = discoveredContracts.size;
    const solanaContracts = Array.from(discoveredContracts.values()).filter(c => c.chain === 'solana');
    
    this.logger.log(`Discovery queue: ${totalContracts} total contracts (${solanaContracts.length} Solana)`);
    
    // Log ALL Solana addresses for inspection (so we can see which ones are bad)
    if (solanaContracts.length > 0) {
      this.logger.log(`Solana contracts to process: ${solanaContracts.map(c => c.address).join(', ')}`);
    }
    
    // Safety limit: only process first 10 to avoid burning API quota
    const contractsToProcess = Array.from(discoveredContracts.entries()).slice(0, 10);
    if (contractsToProcess.length < discoveredContracts.size) {
      this.logger.warn(`Limiting to first ${contractsToProcess.length}/${discoveredContracts.size} contracts to conserve API quota`);
    }
    
    // Add discovered collections to database (after spam filtering)
    const newCollections: Array<{ chain: string; contractAddress: string; name: string }> = [];
    let spamFiltered = 0;
    let rateLimitErrors = 0;
    const maxRateLimitErrors = 1; // Circuit breaker: stop immediately on first rate limit
    
    for (const [key, contract] of contractsToProcess) {
      // Circuit breaker: stop discovery if too many rate limits
      if (rateLimitErrors >= maxRateLimitErrors) {
        this.logger.warn(`Circuit breaker triggered: ${rateLimitErrors} rate limit errors. Stopping discovery.`);
        break;
      }
      
      try {
        // Log what we're about to process (for debugging)
        if (contract.chain === 'solana') {
          this.logger.debug(`Processing Solana address: ${contract.address}`);
        }
        
        // Rate limit: wait 500ms between API calls to avoid 429s
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Fetch metadata with exponential backoff retry on 429
        let metadata = null;
        let retries = 0;
        const maxRetries = 5;
        
        while (retries < maxRetries && !metadata) {
          try {
            metadata = await this.blockchainLookup.getContractMetadata(
              contract.chain,
              contract.address
            );
          } catch (err: any) {
            if (err?.message?.includes('429') && retries < maxRetries - 1) {
              retries++;
              // Exponential backoff: 5s, 10s, 20s, 40s, 80s
              const waitTime = 5000 * Math.pow(2, retries - 1);
              this.logger.warn(`Rate limited on ${contract.address}, waiting ${waitTime/1000}s before retry ${retries}/${maxRetries}...`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
            } else {
              this.logger.error(`Failed to fetch metadata for ${contract.address} after ${retries} retries: ${err?.message}`);
              throw err; // Re-throw if not 429 or out of retries
            }
          }
        }

        // Skip if no metadata or no name (invalid/fake collection)
        if (!metadata?.name) {
          this.logger.debug(`Skipping ${contract.chain}:${contract.address} - no collection name found`);
          continue;
        }

        const name = metadata.name;
        
        // Check for spam BEFORE adding to database
        const spamCheck = await this.spamChecker.checkCollection(contract.chain, contract.address, name);
        
        if (spamCheck.isSpam) {
          spamFiltered++;
          this.logger.log(`Filtered spam: ${name} - ${spamCheck.reason}`);
          continue; // Skip this collection
        }

        // Add to database as unverified (not spam)
        const collectionType = metadata?.tokenType?.toLowerCase() === 'erc1155' ? 'erc1155' : 'erc721';
        
        await this.db.execute(sql`
          INSERT INTO collections (chain, contract_address, name, image_url, supply, collection_type, verification_status, mapping_status, last_seen_at, is_spam)
          VALUES (${contract.chain}, ${contract.address}, ${name}, 
                  ${metadata?.imageUrl || null}, ${metadata?.totalSupply || null}, ${collectionType}, 
                  'tracked_unverified', 'unmapped', NOW(), false)
          ON CONFLICT (chain, contract_address) DO NOTHING
        `);

        newCollections.push({
          chain: contract.chain,
          contractAddress: contract.address,
          name: name,
        });

        this.logger.log(`Added new collection: ${name}`);
      } catch (err: any) {
        // Track rate limit errors for circuit breaker
        if (err?.message?.includes('429')) {
          rateLimitErrors++;
          this.logger.error(`⚠️ RATE LIMIT ${rateLimitErrors}/${maxRateLimitErrors} on ${contract.chain}:${contract.address}`);
          this.logger.error(`This address will trigger circuit breaker. Full queue was: ${Array.from(discoveredContracts.keys()).join(', ')}`);
        } else {
          this.logger.error(`Failed to add collection ${contract.address}: ${err?.message || 'unknown error'}`);
        }
      }
    }

    const processingTime = Date.now() - startTime;

    this.logger.log(
      `Discovery complete: ${newCollections.length} new collections added, ${spamFiltered} filtered as spam, ${rateLimitErrors} rate limit errors, in ${processingTime}ms`
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
