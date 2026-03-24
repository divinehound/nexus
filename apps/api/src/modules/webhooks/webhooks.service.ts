import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, and } from 'drizzle-orm';
import { createHmac } from 'crypto';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, holders, activityFeed, collections } from '@nexus/database';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  verifyAlchemySignature(body: string, signature: string): boolean {
    const signingKey = this.config.get<string>('alchemy.webhookSigningKey');
    if (!signingKey) return true; // Skip verification in dev
    const hmac = createHmac('sha256', signingKey).update(body).digest('hex');
    return hmac === signature;
  }

  async handleAlchemyWebhook(payload: AlchemyWebhookPayload) {
    const { event } = payload;
    if (event?.eventType !== 'NFT_ACTIVITY') return;

    // Alchemy webhooks can come from any EVM chain — resolve chain from the
    // network field, or fall back to looking it up from the collection record.
    const networkToChain: Record<string, string> = {
      'ETH_MAINNET': 'ethereum',
      'BASE_MAINNET': 'base',
      'MATIC_MAINNET': 'polygon',
      'ABSTRACT_MAINNET': 'abstract',
    };
    const webhookChain = event.network ? networkToChain[event.network] : undefined;

    for (const activity of event.data?.activities ?? []) {
      await this.processNftTransfer({
        contractAddress: activity.contractAddress,
        fromAddress: activity.fromAddress,
        toAddress: activity.toAddress,
        tokenId: activity.tokenId,
        chain: webhookChain,
        price: activity.value ? parseFloat(activity.value) : null,
      });
    }
  }

  async handleHeliusWebhook(payload: HeliusWebhookPayload[]) {
    for (const tx of payload) {
      for (const transfer of tx.nftTransfers ?? []) {
        await this.processNftTransfer({
          contractAddress: transfer.mint,
          fromAddress: transfer.fromUserAccount,
          toAddress: transfer.toUserAccount,
          tokenId: transfer.mint,
          chain: 'solana',
          price: transfer.amount ? transfer.amount / 1e9 : null,
        });
      }
    }
  }

  private async processNftTransfer(transfer: NftTransfer) {
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.contractAddress, transfer.contractAddress),
    });

    if (!collection) {
      this.logger.debug(`Unknown collection: ${transfer.contractAddress}`);
      return;
    }

    // Use chain from webhook payload, or fall back to the collection's chain
    const chain = transfer.chain ?? collection.chain;

    // Mark previous holder as no longer current
    if (transfer.fromAddress) {
      await this.db
        .update(holders)
        .set({ isCurrent: false, quantity: 0 })
        .where(
          and(
            eq(holders.walletAddress, transfer.fromAddress),
            eq(holders.collectionId, collection.id),
          ),
        );
    }

    // Upsert new holder
    if (transfer.toAddress) {
      const existing = await this.db.query.holders.findFirst({
        where: and(
          eq(holders.walletAddress, transfer.toAddress),
          eq(holders.collectionId, collection.id),
        ),
      });

      if (existing) {
        await this.db
          .update(holders)
          .set({ isCurrent: true, quantity: existing.quantity + 1 })
          .where(eq(holders.id, existing.id));
      } else {
        await this.db.insert(holders).values({
          walletAddress: transfer.toAddress,
          collectionId: collection.id,
          chain: chain as any,
          quantity: 1,
        });
      }
    }

    // Record in activity feed (only for collections mapped to projects)
    if (transfer.price && transfer.price > 0 && collection.projectId) {
      await this.db.insert(activityFeed).values({
        projectId: collection.projectId,
        activityType: 'sale',
        walletAddress: transfer.toAddress,
        collectionId: collection.id,
        tokenId: transfer.tokenId,
        price: transfer.price,
      });
    }
  }
}

interface NftTransfer {
  contractAddress: string;
  fromAddress: string | null;
  toAddress: string | null;
  tokenId: string;
  chain?: string;
  price: number | null;
}

interface AlchemyWebhookPayload {
  event?: {
    eventType: string;
    network?: string;
    data?: {
      activities?: {
        contractAddress: string;
        fromAddress: string;
        toAddress: string;
        tokenId: string;
        value?: string;
      }[];
    };
  };
}

interface HeliusWebhookPayload {
  nftTransfers?: {
    mint: string;
    fromUserAccount: string;
    toUserAccount: string;
    amount?: number;
  }[];
}
