import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, collections, collectionHolders } from '@nexus/database';

interface AlchemyOwner {
  ownerAddress: string;
  tokenBalances: Array<{
    tokenId: string;
    balance: string;
  }>;
}

interface AlchemyOwnersResponse {
  owners: AlchemyOwner[];
  pageKey?: string;
}

@Injectable()
export class HolderIndexerService {
  private readonly logger = new Logger(HolderIndexerService.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  /**
   * Index all holders for a collection
   * Creates wallet records and holdings snapshots
   */
  async indexCollectionHolders(collectionId: string): Promise<{
    success: boolean;
    holdersIndexed: number;
    error?: string;
  }> {
    try {
      this.logger.log(`Starting full holder index for collection ${collectionId}`);

      // Get collection details
      const collection = await this.db.query.collections.findFirst({
        where: eq(collections.id, collectionId),
      });

      if (!collection) {
        return { success: false, holdersIndexed: 0, error: 'Collection not found' };
      }

      // Fetch all holders based on chain
      const holderResult = collection.chain === 'solana'
        ? await this.fetchSolanaHolders(collection.contractAddress)
        : await this.fetchEvmHolders(collection.chain, collection.contractAddress);
      
      const holders = holderResult.holders;
      this.logger.log(`Fetched ${holders.length} unique holders for ${collection.name}`);

      // Check spam flags from API
      if (holderResult.spamInfo) {
        await this.handleSpamDetection(collectionId, holderResult.spamInfo);
      }

      // Upsert holders
      let indexed = 0;
      for (const holder of holders) {
        await this.upsertHolder(
          collectionId,
          collection.chain,
          holder.ownerAddress,
          holder.balance,
        );
        indexed++;

        if (indexed % 100 === 0) {
          this.logger.log(`Progress: ${indexed}/${holders.length} holders indexed`);
        }
      }

      // Calculate total supply by summing all holder balances
      const totalSupply = holders.reduce((sum, holder) => sum + holder.balance, 0);
      
      this.logger.log(`[Supply Calculation] Collection: ${collection.name}`);
      this.logger.log(`[Supply Calculation] Current supply in DB: ${collection.supply}`);
      this.logger.log(`[Supply Calculation] Calculated total from holders: ${totalSupply}`);
      this.logger.log(`[Supply Calculation] Unique holders: ${holders.length}`);
      
      const newSupply = collection.supply === null || collection.supply === 1 ? totalSupply : collection.supply;
      this.logger.log(`[Supply Calculation] Will set supply to: ${newSupply}`);
      
      // Update collection status
      await this.db
        .update(collections)
        .set({
          holderCount: holders.length,
          // If supply is null or 1 (likely wrong), use summed token count
          // This gives accurate supply based on actual on-chain ownership
          supply: newSupply,
          lastIndexFinishedAt: new Date(),
          lastIndexStatus: 'success',
        })
        .where(eq(collections.id, collectionId));

      this.logger.log(`Completed indexing ${indexed} holders for collection ${collectionId}`);

      return { success: true, holdersIndexed: indexed };
    } catch (error: any) {
      this.logger.error(`Failed to index holders for collection ${collectionId}:`, error);

      // Update error status
      await this.db
        .update(collections)
        .set({
          lastIndexFinishedAt: new Date(),
          lastIndexStatus: 'failed',
          lastIndexError: error.message,
        })
        .where(eq(collections.id, collectionId));

      return { success: false, holdersIndexed: 0, error: error.message };
    }
  }

  /**
   * Fetch all holders for an EVM contract using Alchemy API
   */
  private async fetchEvmHolders(
    chain: string,
    contractAddress: string,
  ): Promise<{
    holders: Array<{ ownerAddress: string; balance: number }>;
    spamInfo?: { isSpam: boolean; score: number; reason?: string };
  }> {
    const apiKey = this.config.get<string>('alchemy.apiKey');
    if (!apiKey) {
      throw new Error('Alchemy API key not configured');
    }

    const network = this.getAlchemyNetwork(chain);
    const baseUrl = `https://${network}.g.alchemy.com/nft/v3/${apiKey}`;
    
    const holders = new Map<string, number>(); // address -> total balance
    let pageKey: string | undefined;
    let spamClassifications: any = null;

    do {
      const url = new URL(`${baseUrl}/getOwnersForContract`);
      url.searchParams.set('contractAddress', contractAddress);
      url.searchParams.set('withTokenBalances', 'true');
      if (pageKey) {
        url.searchParams.set('pageKey', pageKey);
      }

      const response = await fetch(url.toString());
      if (!response.ok) {
        const errorBody = await response.text();
        this.logger.error(
          `Alchemy API error for ${chain}/${contractAddress}: ${response.status} ${response.statusText}`,
        );
        this.logger.error(`Response body: ${errorBody}`);
        throw new Error(`Alchemy API error: ${response.status} ${response.statusText} - ${errorBody}`);
      }

      const data: AlchemyOwnersResponse = await response.json();

      // Capture spam info from first response
      if (!spamClassifications && (data as any).spamClassifications) {
        spamClassifications = (data as any).spamClassifications;
      }

      // Aggregate balances per owner
      // Do not lowercase - addresses are case-sensitive for Solana
      for (const owner of data.owners) {
        const address = owner.ownerAddress;
        const totalBalance = owner.tokenBalances.reduce(
          (sum, tb) => sum + parseInt(tb.balance || '1'),
          0,
        );
        holders.set(address, (holders.get(address) || 0) + totalBalance);
      }

      pageKey = data.pageKey;
    } while (pageKey);

    const holderList = Array.from(holders.entries()).map(([ownerAddress, balance]) => ({
      ownerAddress,
      balance,
    }));

    // Extract spam info if available
    let spamInfo: { isSpam: boolean; score: number; reason?: string } | undefined;
    if (spamClassifications) {
      const isSpam = spamClassifications.isSpam === true;
      const classifications = spamClassifications.classifications || [];
      spamInfo = {
        isSpam,
        score: isSpam ? 90 : 10, // High confidence if Alchemy flags it
        reason: classifications.length > 0 ? classifications.join(', ') : undefined,
      };
    }

    return { holders: holderList, spamInfo };
  }

  /**
   * Fetch all holders for a Solana collection using Helius API
   */
  private async fetchSolanaHolders(
    collectionMint: string,
  ): Promise<{
    holders: Array<{ ownerAddress: string; balance: number }>;
    spamInfo?: { isSpam: boolean; score: number; reason?: string };
  }> {
    const apiKey = this.config.get<string>('helius.apiKey');
    if (!apiKey) {
      throw new Error('Helius API key not configured');
    }

    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    const holders = new Map<string, number>(); // address -> token count
    let page = 1;
    const limit = 1000;

    // Helius DAS API: getAssetsByGroup
    while (true) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `fetch-holders-${page}`,
          method: 'getAssetsByGroup',
          params: {
            groupKey: 'collection',
            groupValue: collectionMint,
            page,
            limit,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Helius API error: ${response.status} ${response.statusText}`);
      }

      const data: any = await response.json();
      const items = data.result?.items || [];

      if (items.length === 0) break;

      // Aggregate by owner
      for (const item of items) {
        const owner = item.ownership?.owner;
        if (owner) {
          holders.set(owner, (holders.get(owner) || 0) + 1);
        }
      }

      this.logger.log(`Fetched page ${page}: ${items.length} NFTs, ${holders.size} unique holders so far`);

      // If we got less than limit, we're done
      if (items.length < limit) break;
      page++;
    }

    const holderList = Array.from(holders.entries()).map(([ownerAddress, balance]) => ({
      ownerAddress,
      balance,
    }));

    // Helius doesn't provide spam detection in getAssetsByGroup
    // Would need separate API call to check collection metadata
    return { holders: holderList, spamInfo: undefined };
  }

  /**
   * Handle spam detection from API response
   */
  private async handleSpamDetection(
    collectionId: string,
    spamInfo: { isSpam: boolean; score: number; reason?: string },
  ) {
    // Only auto-flag high-confidence spam
    if (spamInfo.isSpam && spamInfo.score >= 80) {
      this.logger.warn(
        `Collection ${collectionId} flagged as spam by Alchemy: ${spamInfo.reason || 'no reason provided'}`,
      );

      await this.db
        .update(collections)
        .set({
          isSpam: true,
          spamScore: spamInfo.score,
          spamReason: spamInfo.reason || 'auto-detected',
          spamDetectedAt: new Date(),
          spamDetectedBy: 'alchemy' as any,
        })
        .where(eq(collections.id, collectionId));
    } else if (spamInfo.score > 0) {
      // Log suspicious but not definitive
      this.logger.log(
        `Collection ${collectionId} has spam score ${spamInfo.score} (not auto-flagging)`,
      );

      // Update score but don't mark as spam
      await this.db
        .update(collections)
        .set({
          spamScore: spamInfo.score,
          spamReason: spamInfo.reason,
        })
        .where(eq(collections.id, collectionId));
    }
  }

  /**
   * Upsert holder into collection_holders table
   * This table doesn't require userId, so we can index ALL holders
   */
  private async upsertHolder(
    collectionId: string,
    chain: string,
    address: string,
    tokenCount: number,
  ) {
    // Solana addresses are case-sensitive; EVM addresses should be lowercased
    const normalizedAddress = chain === 'solana' ? address : address.toLowerCase();

    await this.db
      .insert(collectionHolders)
      .values({
        collectionId,
        chain: chain as any,
        address: normalizedAddress,
        tokenCount,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [collectionHolders.collectionId, collectionHolders.address],
        set: {
          tokenCount,
          lastSeenAt: new Date(),
        },
      });
  }

  /**
   * Map chain name to Alchemy network identifier
   */
  private getAlchemyNetwork(chain: string): string {
    const networks: Record<string, string> = {
      ethereum: 'eth-mainnet',
      base: 'base-mainnet',
      polygon: 'polygon-mainnet',
      abstract: 'abstract-mainnet',
      apechain: 'apechain-mainnet',
    };
    return networks[chain] || 'eth-mainnet';
  }
}
