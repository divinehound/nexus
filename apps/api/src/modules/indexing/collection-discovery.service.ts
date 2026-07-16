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
  existingCollectionsInDb: number;
  overlapFloor: number;
  contractsBelowFloor: number;
  newCollectionsFound: number;
  spamFiltered: number;
  newCollections: Array<{
    chain: string;
    contractAddress: string;
    name: string;
    holderOverlap: number;
  }>;
  processingTimeMs: number;
}

// Burn/zero addresses show up as "holders" but aren't real wallets
const IGNORED_HOLDER_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

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
      maxNewContracts?: number;
      minHolderOverlap?: number;
    }
  ): Promise<DiscoveryResult> {
    const startTime = Date.now();
    const maxHolders = options?.maxHolders; // unset = scan every holder
    const maxPerHolder = options?.maxCollectionsPerHolder || 100;
    const maxNewContracts = options?.maxNewContracts || 200;

    this.logger.log(`Starting collection discovery for ${collectionId}`);

    // Get the source collection
    const sourceCollection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!sourceCollection) {
      throw new Error('Collection not found');
    }

    // Get holders (all of them unless a cap was requested)
    const holdersResult = await this.db.execute<{ address: string; chain: string }>(
      maxHolders
        ? sql`
            SELECT DISTINCT address, chain
            FROM collection_holders
            WHERE collection_id = ${collectionId}
            LIMIT ${maxHolders}
          `
        : sql`
            SELECT DISTINCT address, chain
            FROM collection_holders
            WHERE collection_id = ${collectionId}
          `
    );

    this.logger.log(`Checking ${holdersResult.length} holders for new collections`);

    const discoveredContracts = new Map<string, { chain: string; address: string; holderOverlap: number }>();
    const existingContracts = new Set<string>();
    let holdersChecked = 0;

    // Check each holder's other NFTs
    for (const holder of holdersResult) {
      if (IGNORED_HOLDER_ADDRESSES.has(holder.address.toLowerCase())) continue;

      try {
        holdersChecked++;

        // Pace the per-holder NFT lookups to stay under API throughput limits
        if (holdersChecked > 1) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        // Query blockchain for this holder's NFTs
        const nfts = await this.blockchainLookup.getHolderNFTs(
          holder.chain,
          holder.address,
          maxPerHolder
        );

        for (const nft of nfts) {
          // Preserve case for Solana (base58), lowercase for EVM (hex)
          const normalizedAddress = nft.chain === 'solana'
            ? nft.contractAddress
            : nft.contractAddress.toLowerCase();
          const key = `${nft.chain}:${normalizedAddress}`;

          if (existingContracts.has(key)) continue;

          // Count how many of the source collection's holders also hold this
          // contract — the ranking signal for what's worth adding.
          const discovered = discoveredContracts.get(key);
          if (discovered) {
            discovered.holderOverlap++;
            continue;
          }

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

          if (exists) {
            existingContracts.add(key);
          } else {
            discoveredContracts.set(key, {
              chain: nft.chain,
              address: normalizedAddress,
              holderOverlap: 1,
            });
          }
        }

        if (holdersChecked % 50 === 0) {
          this.logger.log(
            `Progress: ${holdersChecked}/${holdersResult.length} holders checked, ${discoveredContracts.size} new contracts, ${existingContracts.size} already in DB`,
          );
        }
      } catch (err: any) {
        this.logger.warn(`Failed to check holder ${holder.address}: ${err?.message || 'unknown error'}`);
      }
    }

    // Selectivity: require a minimum co-holder overlap before a contract is
    // worth a metadata fetch — one-off holdings are noise, genuine community
    // adjacency shows up as many distinct holders. Default floor: 3 holders
    // or 0.5% of holders checked, whichever is greater.
    const overlapFloor = options?.minHolderOverlap ?? Math.max(3, Math.ceil(holdersChecked * 0.005));
    const eligible = Array.from(discoveredContracts.values())
      .filter(c => c.holderOverlap >= overlapFloor)
      .sort((a, b) => b.holderOverlap - a.holderOverlap);
    const contractsBelowFloor = discoveredContracts.size - eligible.length;

    this.logger.log(
      `Discovery queue: ${discoveredContracts.size} distinct new contracts; ` +
      `${eligible.length} meet the >=${overlapFloor}-holder overlap floor (${contractsBelowFloor} dropped as noise)`,
    );

    const solanaContracts = eligible.filter(c => c.chain === 'solana');
    // Log ALL Solana addresses for inspection (so we can see which ones are bad)
    if (solanaContracts.length > 0) {
      this.logger.log(`Solana contracts to process: ${solanaContracts.map(c => c.address).join(', ')}`);
    }

    // Safety limit on metadata fetches per run (override via maxNewContracts).
    // The queue is sorted by overlap, so the cap keeps the best candidates.
    const contractsToProcess = eligible.slice(0, maxNewContracts);
    if (contractsToProcess.length < eligible.length) {
      this.logger.warn(
        `Limiting to top ${contractsToProcess.length}/${eligible.length} contracts by overlap to conserve API quota (pass maxNewContracts to raise)`,
      );
    }
    
    // Add discovered collections to database (after spam filtering)
    const newCollections: Array<{ chain: string; contractAddress: string; name: string; holderOverlap: number }> = [];
    let spamFiltered = 0;
    let rateLimitErrors = 0;
    const maxRateLimitErrors = 1; // Circuit breaker: stop immediately on first rate limit

    for (const contract of contractsToProcess) {
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
        
        // Fetch metadata with exponential backoff retry on 429. A null
        // return (contract has no metadata) is a final answer — only a
        // thrown 429 warrants a retry, otherwise this loops forever.
        let metadata = null;
        const maxRetries = 5;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            metadata = await this.blockchainLookup.getContractMetadata(
              contract.chain,
              contract.address
            );
            break;
          } catch (err: any) {
            if (err?.message?.includes('429') && attempt < maxRetries) {
              // Exponential backoff: 5s, 10s, 20s, 40s
              const waitTime = 5000 * Math.pow(2, attempt - 1);
              this.logger.warn(`Rate limited on ${contract.address}, waiting ${waitTime/1000}s before retry ${attempt}/${maxRetries}...`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
            } else {
              this.logger.error(`Failed to fetch metadata for ${contract.address} after ${attempt} attempts: ${err?.message}`);
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

        // Supply sanity gate: single-token contracts have no community to
        // analyze, and six-figure supplies are open-edition/airdrop farms.
        const supply = metadata?.totalSupply ? Number.parseInt(String(metadata.totalSupply), 10) : null;
        if (supply !== null && Number.isFinite(supply) && (supply < 2 || supply > 100000)) {
          this.logger.log(`Skipping ${name} (${contract.chain}:${contract.address}) - supply ${supply} out of range`);
          continue;
        }

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
          INSERT INTO collections (chain, contract_address, name, image_url, supply, collection_type, verification_status, mapping_status, last_seen_at, is_spam, discovered_overlap_count, discovered_from_collection_id)
          VALUES (${contract.chain}, ${contract.address}, ${name},
                  ${metadata?.imageUrl || null}, ${metadata?.totalSupply || null}, ${collectionType},
                  'tracked_unverified', 'unmapped', NOW(), false, ${contract.holderOverlap}, ${sourceCollection.id})
          ON CONFLICT (chain, contract_address) DO NOTHING
        `);

        newCollections.push({
          chain: contract.chain,
          contractAddress: contract.address,
          name: name,
          holderOverlap: contract.holderOverlap,
        });

        this.logger.log(`Added new collection: ${name} (held by ${contract.holderOverlap} of ${holdersChecked} holders)`);
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
      `Discovery complete for ${sourceCollection.name}: ${holdersChecked} holders checked, ` +
      `${existingContracts.size} collections already in DB, ${newCollections.length} new collections added, ` +
      `${spamFiltered} filtered as spam, ${rateLimitErrors} rate limit errors, in ${Math.round(processingTime / 1000)}s`
    );

    return {
      collectionId: sourceCollection.id,
      collectionName: sourceCollection.name,
      holdersChecked,
      existingCollectionsInDb: existingContracts.size,
      overlapFloor,
      contractsBelowFloor,
      newCollectionsFound: newCollections.length,
      spamFiltered,
      newCollections,
      processingTimeMs: processingTime,
    };
  }
}
