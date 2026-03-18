import { Injectable, Inject, ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, activityFeed, flexReactions, collections } from '@nexus/database';
import { HolderVerificationService } from './holder-verification.service';

@Injectable()
export class ActivityService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly holderVerification: HolderVerificationService,
  ) {}

  async getByProjectId(projectId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    return this.db.query.activityFeed.findMany({
      where: eq(activityFeed.projectId, projectId),
      limit,
      offset,
      orderBy: (activityFeed, { desc }) => [desc(activityFeed.createdAt)],
      with: { reactions: true },
    });
  }

  async createFlex(
    projectId: string,
    data: { walletAddress: string; collectionId: string; tokenId: string; message?: string; imageUrl?: string },
  ) {
    // Verify wallet actually holds the NFT on-chain
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, data.collectionId),
    });

    if (collection) {
      const isHolder =
        collection.chain === 'solana'
          ? await this.holderVerification.verifySolanaHolder(
              data.walletAddress,
              data.tokenId,
            )
          : await this.holderVerification.verifyEthereumHolder(
              data.walletAddress,
              collection.contractAddress,
              data.tokenId,
            );

      if (!isHolder) {
        throw new ForbiddenException(
          'Wallet does not hold this NFT — cannot post flex',
        );
      }
    }

    const [flex] = await this.db
      .insert(activityFeed)
      .values({
        projectId,
        activityType: 'flex',
        walletAddress: data.walletAddress,
        collectionId: data.collectionId,
        tokenId: data.tokenId,
        message: data.message ?? null,
        imageUrl: data.imageUrl ?? null,
      })
      .returning();
    return flex;
  }

  async addReaction(activityId: string, walletAddress: string) {
    const [reaction] = await this.db
      .insert(flexReactions)
      .values({ activityId, walletAddress })
      .returning();
    return reaction;
  }
}
