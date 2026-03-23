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
   * Uses getContractMetadata endpoint which includes spam detection
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

      // Debug: Log full response for known spam contracts
      const knownSpamContracts = [
        '0x906cb022cd0b5125b522dc4f1daf70c6ba05d852',
        '0xee523cb3545b086d038aae125ff57bab855e9113',
      ];
      if (knownSpamContracts.includes(contractAddress.toLowerCase())) {
        this.logger.log(
          `DEBUG spam contract ${chain}/${contractAddress}:\n${JSON.stringify(data, null, 2)}`,
        );
      }

      // Check multiple possible spam indicators
      const openSeaSpam = data.openSeaMetadata?.isSpam === true;
      const openSeaSafelistStatus = data.openSeaMetadata?.safelistRequestStatus;
      const contractDeployer = data.contractDeployer;
      
      // Log what we found
      if (openSeaSpam || openSeaSafelistStatus === 'not_requested') {
        this.logger.log(
          `Potential spam: ${chain}/${contractAddress} - ` +
          `openSeaSpam=${openSeaSpam}, safelistStatus=${openSeaSafelistStatus}`,
        );
      }
      
      if (openSeaSpam) {
        return {
          isSpam: true,
          score: 90,
          reason: 'opensea_spam_flag',
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
