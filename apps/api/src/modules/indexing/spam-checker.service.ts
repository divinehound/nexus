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
   * Uses getOwnersForContract (same as holder indexing) which includes spam data
   */
  private async checkCollectionSpam(
    chain: string,
    contractAddress: string,
    apiKey: string,
  ): Promise<{ isSpam: boolean; score: number; reason?: string } | null> {
    const network = this.getAlchemyNetwork(chain);
    const url = new URL(`https://${network}.g.alchemy.com/nft/v3/${apiKey}/getOwnersForContract`);
    url.searchParams.set('contractAddress', contractAddress);
    url.searchParams.set('withTokenBalances', 'false'); // We don't need token data
    url.searchParams.set('pageSize', '1'); // Minimal data

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        this.logger.warn(`Alchemy API error for ${chain}/${contractAddress}: ${response.status}`);
        return null;
      }

      const data: any = await response.json();

      // Check for spam classifications (same structure as holder indexing)
      const spamClassifications = data.spamClassifications;
      if (spamClassifications) {
        const isSpam = spamClassifications.isSpam === true;
        const classifications = spamClassifications.classifications || [];
        
        this.logger.debug(
          `Spam check for ${chain}/${contractAddress}: isSpam=${isSpam}, classifications=${classifications.join(', ')}`,
        );

        return {
          isSpam,
          score: isSpam ? 90 : 10,
          reason: classifications.length > 0 ? classifications.join(', ') : undefined,
        };
      }

      // No spam data in response
      return null;
    } catch (err: any) {
      this.logger.error(`Error checking spam for ${chain}/${contractAddress}: ${err.message}`);
      return null;
    }
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
