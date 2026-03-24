import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, collections } from '@nexus/database';

/**
 * Service for checking existing collections against spam APIs
 */
@Injectable()
export class SpamCheckerService {
  private readonly logger = new Logger(SpamCheckerService.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  /**
   * Check all EVM collections for spam flags via Alchemy
   * Updates spam status for high-confidence spam
   */
  async checkAllCollections(): Promise<{
    checked: number;
    flagged: number;
    errors: number;
  }> {
    const apiKey = this.config.get<string>('alchemy.apiKey');
    if (!apiKey) {
      throw new Error('Alchemy API key not configured');
    }

    // Get all EVM collections (Solana doesn't have spam detection)
    const evmChains: Array<'ethereum' | 'base' | 'polygon' | 'abstract' | 'apechain'> = [
      'ethereum',
      'base',
      'polygon',
      'abstract',
      'apechain',
    ];
    const allCollections = await this.db.query.collections.findMany({
      where: (c, { inArray }) => inArray(c.chain, evmChains),
    });

    this.logger.log(`Checking ${allCollections.length} EVM collections for spam...`);

    let checked = 0;
    let flagged = 0;
    let errors = 0;

    for (const collection of allCollections) {
      try {
        const spamInfo = await this.checkCollectionSpam(
          collection.chain,
          collection.contractAddress,
          apiKey,
        );

        if (spamInfo?.isSpam && spamInfo.score >= 80) {
          // Auto-flag high-confidence spam
          await this.db
            .update(collections)
            .set({
              isSpam: true,
              spamScore: spamInfo.score,
              spamReason: spamInfo.reason || 'auto-detected',
              spamDetectedAt: new Date(),
              spamDetectedBy: 'alchemy' as any,
            })
            .where(eq(collections.id, collection.id));

          flagged++;
          this.logger.log(
            `Flagged ${collection.name} (${collection.chain}/${collection.contractAddress}) as spam`,
          );
        } else if (spamInfo && spamInfo.score > 0) {
          // Update score but don't flag
          await this.db
            .update(collections)
            .set({
              spamScore: spamInfo.score,
              spamReason: spamInfo.reason,
            })
            .where(eq(collections.id, collection.id));
        }

        checked++;

        // Log progress every 50 collections
        if (checked % 50 === 0) {
          this.logger.log(`Progress: ${checked}/${allCollections.length} checked, ${flagged} flagged`);
        }

        // Small delay to avoid rate limits (10 requests per second max)
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (err: any) {
        this.logger.error(
          `Failed to check ${collection.chain}/${collection.contractAddress}: ${err.message}`,
          err.stack,
        );
        errors++;
      }
    }

    this.logger.log(`Completed: ${checked} checked, ${flagged} flagged as spam, ${errors} errors`);

    return { checked, flagged, errors };
  }

  /**
   * Check a single collection for spam via Alchemy
   * Uses getContractMetadata endpoint with heuristic spam detection
   */
  private async checkCollectionSpam(
    chain: string,
    contractAddress: string,
    apiKey: string,
  ): Promise<{ isSpam: boolean; score: number; reason?: string } | null> {
    const network = this.getAlchemyNetwork(chain);
    const url = new URL(`https://${network}.g.alchemy.com/nft/v3/${apiKey}/getContractMetadata`);
    url.searchParams.set('contractAddress', contractAddress);

    try {
      const response = await fetch(url.toString());

      if (!response.ok) {
        this.logger.warn(`Alchemy API error for ${chain}/${contractAddress}: ${response.status}`);
        return null;
      }

      const data: any = await response.json();

      // Heuristic spam detection
      const name = (data.name || '').toLowerCase();
      const symbol = (data.symbol || '').toLowerCase();
      const safelistStatus = data.openSeaMetadata?.safelistRequestStatus;
      const openSeaSpam = data.openSeaMetadata?.isSpam === true;

      // High-confidence spam patterns
      const spamKeywords = [
        'claim', 'reward', 'airdrop', 'bonus', 'free', 'gift',
        'visit', 'http', '.com', '.org', '.net', '.io', '.xyz',
        '10bnb', '100eth', '1000usdt', 'rewards.', 'claimit',
      ];

      const hasSpamKeyword = spamKeywords.some(
        (keyword) => name.includes(keyword) || symbol.includes(keyword),
      );

      // Check for obvious spam patterns
      if (openSeaSpam) {
        return {
          isSpam: true,
          score: 95,
          reason: 'opensea_spam_flag',
        };
      }

      if (hasSpamKeyword) {
        this.logger.log(
          `Spam detected: ${chain}/${contractAddress} - name="${data.name}", symbol="${data.symbol}"`,
        );
        return {
          isSpam: true,
          score: 90,
          reason: 'spam_keywords_in_name',
        };
      }

      // Not spam based on available data
      return {
        isSpam: false,
        score: 0,
        reason: undefined,
      };
    } catch (err: any) {
      this.logger.error(`Error checking spam for ${chain}/${contractAddress}: ${err.message}`);
      return null;
    }
  }

  /**
   * Debug endpoint: Return raw Alchemy response for a collection
   */
  /**
   * Check a single collection for spam (used during discovery)
   * Returns spam status without storing in database
   */
  async checkCollection(
    chain: string,
    contractAddress: string,
    name?: string
  ): Promise<{ isSpam: boolean; score: number; reason?: string }> {
    const apiKey = this.config.get<string>('alchemy.apiKey');
    
    // If no API key or Solana (not supported), use heuristic only
    if (!apiKey || chain === 'solana') {
      return this.checkHeuristics(name || '', '');
    }

    const result = await this.checkCollectionSpam(chain, contractAddress, apiKey);
    
    if (result) {
      return result;
    }
    
    // Fallback to heuristic if API fails
    return this.checkHeuristics(name || '', '');
  }

  /**
   * Heuristic spam detection based on name/symbol patterns
   */
  private checkHeuristics(name: string, symbol: string): { isSpam: boolean; score: number; reason?: string } {
    const lowerName = name.toLowerCase();
    const lowerSymbol = symbol.toLowerCase();

    const spamKeywords = [
      'claim', 'reward', 'airdrop', 'bonus', 'free', 'gift',
      'visit', 'http', '.com', '.org', '.net', '.io', '.xyz',
      '10bnb', '100eth', '1000usdt', 'rewards.', 'claimit',
    ];

    const hasSpamKeyword = spamKeywords.some(
      (keyword) => lowerName.includes(keyword) || lowerSymbol.includes(keyword),
    );

    if (hasSpamKeyword) {
      return { isSpam: true, score: 90, reason: 'spam_keywords_in_name' };
    }

    return { isSpam: false, score: 0 };
  }

  async checkCollectionRaw(chain: string, contractAddress: string) {
    const apiKey = this.config.get<string>('alchemy.apiKey');
    if (!apiKey) {
      throw new Error('Alchemy API key not configured');
    }

    const network = this.getAlchemyNetwork(chain);
    const url = new URL(`https://${network}.g.alchemy.com/nft/v3/${apiKey}/getOwnersForContract`);
    url.searchParams.set('contractAddress', contractAddress);
    url.searchParams.set('withTokenBalances', 'false');
    url.searchParams.set('pageSize', '1');

    const response = await fetch(url.toString());
    const data = await response.json();

    return {
      chain,
      contractAddress,
      network,
      responseStatus: response.status,
      spamClassifications: data.spamClassifications || null,
      fullResponse: data,
    };
  }

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
