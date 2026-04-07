import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  type Database,
  collections,
  collectionHolderBalanceHistory,
  collectionHolderSummaries,
  collectionHolders,
} from '@nexus/database';

type ScanStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed';

type InMemoryScanJob = {
  collectionId: string;
  status: ScanStatus;
  fromBlock: number;
  toBlock?: number;
  startedAt?: string;
  finishedAt?: string;
  processedTransfers: number;
  touchedWallets: number;
  error?: string;
  pageKey?: string;
  mode?: 'alchemy_backfill' | 'helius_backfill';
};

type AlchemyTransfer = {
  hash: string;
  from: string;
  to: string;
  erc721TokenId?: string;
  blockNum: string;
  metadata?: {
    blockTimestamp?: string;
  };
};

type MutableSummary = {
  currentBalance: number;
  firstReceivedAt: Date | null;
  firstReceivedBlock: number | null;
  lastReceivedAt: Date | null;
  lastReceivedBlock: number | null;
  totalReceivedCount: number;
  totalSentCount: number;
};

type SolanaAsset = {
  id: string;
  ownership?: {
    owner?: string;
  };
  grouping?: Array<{ group_key?: string; group_value?: string }>;
};

type HeliusTransaction = {
  signature?: string;
  timestamp?: number;
  tokenTransfers?: Array<{
    mint?: string;
    fromUserAccount?: string;
    toUserAccount?: string;
    tokenAmount?: number;
  }>;
};

@Injectable()
export class HolderHistoryService {
  private readonly logger = new Logger(HolderHistoryService.name);
  private readonly jobs = new Map<string, InMemoryScanJob>();

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  async getCollectionHolderHistory(collectionId: string) {
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!collection) throw new NotFoundException('Collection not found');

    const wallets = await this.db.query.collectionHolderSummaries.findMany({
      where: eq(collectionHolderSummaries.collectionId, collectionId),
      orderBy: [desc(collectionHolderSummaries.currentBalance), asc(collectionHolderSummaries.address)],
    });

    const history = await this.db.query.collectionHolderBalanceHistory.findMany({
      where: eq(collectionHolderBalanceHistory.collectionId, collectionId),
      orderBy: [asc(collectionHolderBalanceHistory.blockNumber), asc(collectionHolderBalanceHistory.logIndex)],
    });

    return {
      collection,
      summary: {
        wallets,
        totalWallets: wallets.filter((w) => w.currentBalance > 0).length,
        totalTokensHeld: wallets.reduce((sum, w) => sum + w.currentBalance, 0),
      },
      balanceHistory: history,
      scanJob: this.jobs.get(collectionId) ?? null,
    };
  }

  async queueCollectionHolderHistoryScan(collectionId: string, input?: { fromBlock?: number }) {
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!collection) throw new NotFoundException('Collection not found');

    const existing = this.jobs.get(collectionId);
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      return { queued: true, alreadyRunning: true, job: existing };
    }

    const fromBlock = input?.fromBlock ?? (collection.holderHistoryLastCheckedBlock ? collection.holderHistoryLastCheckedBlock + 1 : 0);
    const job: InMemoryScanJob = {
      collectionId,
      status: 'queued',
      fromBlock,
      processedTransfers: 0,
      touchedWallets: 0,
      mode: collection.chain === 'solana' ? 'helius_backfill' : 'alchemy_backfill',
    };

    this.jobs.set(collectionId, job);
    this.logger.log(`Queued holder history scan for ${collectionId} from block ${fromBlock}`);

    setTimeout(() => {
      this.logger.log(`Starting async holder history scan for ${collectionId}`);
      void this.runCollectionHolderHistoryScan(collectionId, fromBlock).catch((error) => {
        this.logger.error(`Holder history scan failed for ${collectionId}: ${error?.message || error}`);
      });
    }, 0);

    return { queued: true, alreadyRunning: false, job };
  }

  async getCollectionHolderHistoryScanStatus(collectionId: string) {
    return this.jobs.get(collectionId) ?? { collectionId, status: 'idle' };
  }

  private async runCollectionHolderHistoryScan(collectionId: string, fromBlockInput?: number) {
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!collection) throw new NotFoundException('Collection not found');

    const job = this.jobs.get(collectionId) ?? {
      collectionId,
      status: 'queued' as const,
      fromBlock: fromBlockInput ?? 0,
      processedTransfers: 0,
      touchedWallets: 0,
      mode: collection.chain === 'solana' ? ('helius_backfill' as const) : ('alchemy_backfill' as const),
    };

    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.jobs.set(collectionId, job);

    try {
      if (collection.chain === 'solana') {
        await this.runSolanaCollectionHolderHistoryScan(collection, job);
      } else {
        await this.runEvmCollectionHolderHistoryScan(collection, job, fromBlockInput);
      }
    } catch (error: any) {
      this.logger.error(`runCollectionHolderHistoryScan failed for ${collectionId}: ${error?.message || error}`);
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = error?.message || 'Unknown error';
      this.jobs.set(collectionId, { ...job });

      await this.db
        .update(collections)
        .set({
          lastIndexFinishedAt: new Date(),
          lastIndexStatus: 'failed',
          lastIndexError: error?.message || 'Unknown error',
        })
        .where(eq(collections.id, collectionId));

      throw error;
    }
  }

  private async runEvmCollectionHolderHistoryScan(
    collection: typeof collections.$inferSelect,
    job: InMemoryScanJob,
    fromBlockInput?: number,
  ) {
    const apiKey = this.config.get<string>('alchemy.apiKey');
    if (!apiKey) {
      throw new Error('Alchemy API key not configured');
    }

    const fromBlock = fromBlockInput ?? (collection.holderHistoryLastCheckedBlock ? collection.holderHistoryLastCheckedBlock + 1 : 0);
    job.fromBlock = fromBlock;

    const existingSummaries = await this.db.query.collectionHolderSummaries.findMany({
      where: eq(collectionHolderSummaries.collectionId, collection.id),
    });

    const summaryState = new Map<string, MutableSummary>();
    for (const row of existingSummaries) {
      summaryState.set(row.address.toLowerCase(), {
        currentBalance: row.currentBalance,
        firstReceivedAt: row.firstReceivedAt,
        firstReceivedBlock: row.firstReceivedBlock,
        lastReceivedAt: row.lastReceivedAt,
        lastReceivedBlock: row.lastReceivedBlock,
        totalReceivedCount: row.totalReceivedCount,
        totalSentCount: row.totalSentCount,
      });
    }

    const touched = new Set<string>();
    let maxBlockNumber = collection.holderHistoryLastCheckedBlock ?? fromBlock;
    let pageKey: string | undefined;
    let page = 0;
    const network = this.getAlchemyNetwork(collection.chain);
    const endpoint = `https://${network}.g.alchemy.com/v2/${apiKey}`;

    while (true) {
      page += 1;
      const response = await this.withTimeout(
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: page,
            method: 'alchemy_getAssetTransfers',
            params: [
              {
                fromBlock: toHexBlock(fromBlock),
                toBlock: 'latest',
                contractAddresses: [collection.contractAddress],
                category: ['erc721'],
                withMetadata: true,
                excludeZeroValue: false,
                maxCount: '0x3e8',
                order: 'asc',
                ...(pageKey ? { pageKey } : {}),
              },
            ],
          }),
        }),
        30000,
        `alchemy_getAssetTransfers page ${page}`,
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Alchemy transfers request failed (${response.status}): ${text}`);
      }

      const data = (await response.json()) as {
        result?: { transfers?: AlchemyTransfer[]; pageKey?: string };
        error?: { message?: string };
      };

      if (data.error) {
        throw new Error(data.error.message || 'Alchemy transfers error');
      }

      const transfers = data.result?.transfers ?? [];
      pageKey = data.result?.pageKey;
      job.pageKey = pageKey;

      const historyRows: Array<typeof collectionHolderBalanceHistory.$inferInsert> = [];
      const perWalletLogIndex = new Map<string, number>();

      for (const transfer of transfers) {
        const from = (transfer.from || '').toLowerCase();
        const to = (transfer.to || '').toLowerCase();
        const tokenId = normalizeTokenId(transfer.erc721TokenId);
        const txHash = transfer.hash;
        const blockNumber = Number.parseInt(transfer.blockNum, 16);
        const blockTimestamp = transfer.metadata?.blockTimestamp ? new Date(transfer.metadata.blockTimestamp) : new Date();
        maxBlockNumber = Math.max(maxBlockNumber, blockNumber);

        if (from && from !== ZERO_ADDRESS) {
          const summary = ensureSummary(summaryState, from);
          summary.currentBalance = Math.max(summary.currentBalance - 1, 0);
          summary.totalSentCount += 1;
          touched.add(from);
          const key = `${txHash}:${from}`;
          const logIndex = (perWalletLogIndex.get(key) ?? 0) + 1;
          perWalletLogIndex.set(key, logIndex);
          historyRows.push({
            collectionId: collection.id,
            chain: collection.chain,
            address: from,
            blockNumber,
            blockTimestamp,
            transactionHash: txHash,
            logIndex,
            tokenId,
            direction: 'out',
            balanceAfter: summary.currentBalance,
            counterpartyAddress: to || null,
          });
        }

        if (to && to !== ZERO_ADDRESS) {
          const summary = ensureSummary(summaryState, to);
          summary.currentBalance += 1;
          summary.totalReceivedCount += 1;
          if (!summary.firstReceivedAt || (summary.firstReceivedBlock ?? Number.MAX_SAFE_INTEGER) > blockNumber) {
            summary.firstReceivedAt = blockTimestamp;
            summary.firstReceivedBlock = blockNumber;
          }
          summary.lastReceivedAt = blockTimestamp;
          summary.lastReceivedBlock = blockNumber;
          touched.add(to);
          const key = `${txHash}:${to}`;
          const logIndex = (perWalletLogIndex.get(key) ?? 0) + 1;
          perWalletLogIndex.set(key, logIndex);
          historyRows.push({
            collectionId: collection.id,
            chain: collection.chain,
            address: to,
            blockNumber,
            blockTimestamp,
            transactionHash: txHash,
            logIndex,
            tokenId,
            direction: 'in',
            balanceAfter: summary.currentBalance,
            counterpartyAddress: from || null,
          });
        }
      }

      await this.persistHistoryBatch(historyRows);

      job.processedTransfers += transfers.length;
      job.touchedWallets = touched.size;
      job.toBlock = maxBlockNumber;
      this.jobs.set(collection.id, { ...job });
      this.logger.log(`Alchemy holder history page ${page} for ${collection.id}. Transfers so far: ${job.processedTransfers}`);

      if (!pageKey) {
        break;
      }
    }

    await this.persistFinalHolderState(collection, summaryState, touched, maxBlockNumber, job);
  }

  private async runSolanaCollectionHolderHistoryScan(
    collection: typeof collections.$inferSelect,
    job: InMemoryScanJob,
  ) {
    const heliusApiKey = this.config.get<string>('HELIUS_API_KEY');
    if (!heliusApiKey) {
      throw new Error('HELIUS_API_KEY not configured');
    }

    const existingSummaries = await this.db.query.collectionHolderSummaries.findMany({
      where: eq(collectionHolderSummaries.collectionId, collection.id),
    });

    const summaryState = new Map<string, MutableSummary>();
    for (const row of existingSummaries) {
      summaryState.set(row.address.toLowerCase(), {
        currentBalance: row.currentBalance,
        firstReceivedAt: row.firstReceivedAt,
        firstReceivedBlock: row.firstReceivedBlock,
        lastReceivedAt: row.lastReceivedAt,
        lastReceivedBlock: row.lastReceivedBlock,
        totalReceivedCount: row.totalReceivedCount,
        totalSentCount: row.totalSentCount,
      });
    }

    const touched = new Set<string>();
    let syntheticBlock = collection.holderHistoryLastCheckedBlock ?? 0;
    let page = 1;
    let pageCursor: string | undefined;

    while (true) {
      const payload: Record<string, unknown> = {
        jsonrpc: '2.0',
        id: page,
        method: 'getAssetsByGroup',
        params: {
          groupKey: 'collection',
          groupValue: collection.contractAddress,
          page,
          limit: 1000,
          ...(pageCursor ? { pageCursor } : {}),
        },
      };

      const response = await this.withTimeout(
        fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        30000,
        `helius getAssetsByGroup page ${page}`,
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Helius assets request failed (${response.status}): ${text}`);
      }

      const data = (await response.json()) as {
        result?: { items?: SolanaAsset[]; pageCursor?: string };
        error?: { message?: string };
      };

      if (data.error) {
        throw new Error(data.error.message || 'Helius getAssetsByGroup error');
      }

      const assets = data.result?.items ?? [];
      pageCursor = data.result?.pageCursor;
      const historyRows: Array<typeof collectionHolderBalanceHistory.$inferInsert> = [];

      for (const asset of assets) {
        await sleep(80);
        const txs = await this.fetchHeliusAssetTransactionHistory(asset.id, heliusApiKey);
        let runningOwner = '';

        for (const tx of txs) {
          const timestamp = new Date((tx.timestamp ?? Math.floor(Date.now() / 1000)) * 1000);
          const tokenTransfers = tx.tokenTransfers?.filter((transfer) => transfer.mint === asset.id) ?? [];

          for (const transfer of tokenTransfers) {
            const from = (transfer.fromUserAccount || '').toLowerCase();
            const to = (transfer.toUserAccount || '').toLowerCase();
            syntheticBlock += 1;
            const txHash = tx.signature || `${asset.id}:${syntheticBlock}`;

            if (from && from !== ZERO_ADDRESS) {
              const summary = ensureSummary(summaryState, from);
              summary.currentBalance = Math.max(summary.currentBalance - 1, 0);
              summary.totalSentCount += 1;
              touched.add(from);
              historyRows.push({
                collectionId: collection.id,
                chain: collection.chain,
                address: from,
                blockNumber: syntheticBlock,
                blockTimestamp: timestamp,
                transactionHash: txHash,
                logIndex: 1,
                tokenId: asset.id,
                direction: 'out',
                balanceAfter: summary.currentBalance,
                counterpartyAddress: to || null,
              });
            }

            if (to && to !== ZERO_ADDRESS) {
              const summary = ensureSummary(summaryState, to);
              summary.currentBalance += 1;
              summary.totalReceivedCount += 1;
              if (!summary.firstReceivedAt || (summary.firstReceivedBlock ?? Number.MAX_SAFE_INTEGER) > syntheticBlock) {
                summary.firstReceivedAt = timestamp;
                summary.firstReceivedBlock = syntheticBlock;
              }
              summary.lastReceivedAt = timestamp;
              summary.lastReceivedBlock = syntheticBlock;
              touched.add(to);
              historyRows.push({
                collectionId: collection.id,
                chain: collection.chain,
                address: to,
                blockNumber: syntheticBlock,
                blockTimestamp: timestamp,
                transactionHash: txHash,
                logIndex: 2,
                tokenId: asset.id,
                direction: 'in',
                balanceAfter: summary.currentBalance,
                counterpartyAddress: from || null,
              });
              runningOwner = to;
            }
          }
        }

        if (!txs.length && asset.ownership?.owner) {
          const owner = asset.ownership.owner.toLowerCase();
          const summary = ensureSummary(summaryState, owner);
          summary.currentBalance += 1;
          touched.add(owner);
          runningOwner = owner;
        }

        if (runningOwner) {
          touched.add(runningOwner);
        }

        await this.persistHistoryBatch(historyRows);
        job.processedTransfers += historyRows.length;
        job.touchedWallets = touched.size;
        job.toBlock = syntheticBlock;
        this.jobs.set(collection.id, { ...job });
      }

      this.logger.log(`Helius holder history page ${page} for ${collection.id}. Transfers so far: ${job.processedTransfers}`);

      if (!pageCursor || assets.length === 0) {
        break;
      }

      page += 1;
    }

    await this.persistFinalHolderState(collection, summaryState, touched, syntheticBlock, job);
  }

  private async fetchHeliusAssetTransactionHistory(assetId: string, apiKey: string): Promise<HeliusTransaction[]> {
    const response = await this.withTimeout(
      fetch(`https://api.helius.xyz/v0/addresses/${assetId}/transactions?api-key=${apiKey}&limit=100`),
      30000,
      `helius transaction history ${assetId}`,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Helius transaction history failed (${response.status}): ${text}`);
    }

    return (await response.json()) as HeliusTransaction[];
  }

  private async persistHistoryBatch(rows: Array<typeof collectionHolderBalanceHistory.$inferInsert>) {
    if (!rows.length) return;
    for (const batch of chunkArray(rows, 500)) {
      await this.db.insert(collectionHolderBalanceHistory).values(batch).onConflictDoNothing();
    }
  }

  private async persistFinalHolderState(
    collection: typeof collections.$inferSelect,
    summaryState: Map<string, MutableSummary>,
    touched: Set<string>,
    maxBlockNumber: number,
    job: InMemoryScanJob,
  ) {
    const summaryRows: Array<typeof collectionHolderSummaries.$inferInsert> = [];
    const holderRows: Array<typeof collectionHolders.$inferInsert> = [];

    for (const [address, summary] of summaryState.entries()) {
      if (!touched.has(address) && summary.currentBalance === 0 && summary.totalReceivedCount === 0 && summary.totalSentCount === 0) {
        continue;
      }

      summaryRows.push({
        collectionId: collection.id,
        chain: collection.chain,
        address,
        currentBalance: summary.currentBalance,
        firstReceivedAt: summary.firstReceivedAt,
        firstReceivedBlock: summary.firstReceivedBlock,
        lastReceivedAt: summary.lastReceivedAt,
        lastReceivedBlock: summary.lastReceivedBlock,
        totalReceivedCount: summary.totalReceivedCount,
        totalSentCount: summary.totalSentCount,
        updatedAt: new Date(),
      });

      holderRows.push({
        collectionId: collection.id,
        chain: collection.chain,
        address,
        tokenCount: summary.currentBalance,
        firstSeenAt: summary.firstReceivedAt ?? new Date(),
        lastSeenAt: new Date(),
      });
    }

    if (summaryRows.length > 0) {
      for (const batch of chunkArray(summaryRows, 500)) {
        await this.db.insert(collectionHolderSummaries).values(batch).onConflictDoUpdate({
          target: [collectionHolderSummaries.collectionId, collectionHolderSummaries.address],
          set: {
            currentBalance: sql`excluded.current_balance`,
            firstReceivedAt: sql`excluded.first_received_at`,
            firstReceivedBlock: sql`excluded.first_received_block`,
            lastReceivedAt: sql`excluded.last_received_at`,
            lastReceivedBlock: sql`excluded.last_received_block`,
            totalReceivedCount: sql`excluded.total_received_count`,
            totalSentCount: sql`excluded.total_sent_count`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
      }
    }

    if (holderRows.length > 0) {
      for (const batch of chunkArray(holderRows, 500)) {
        await this.db.insert(collectionHolders).values(batch).onConflictDoUpdate({
          target: [collectionHolders.collectionId, collectionHolders.address],
          set: {
            tokenCount: sql`excluded.token_count`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
        });
      }
    }

    await this.db
      .update(collections)
      .set({
        holderHistoryLastCheckedBlock: maxBlockNumber,
        holderHistoryLastScannedAt: new Date(),
        holderCount: Array.from(summaryState.values()).filter((v) => v.currentBalance > 0).length,
        lastIndexFinishedAt: new Date(),
        lastIndexStatus: 'success',
        lastIndexError: null,
      })
      .where(eq(collections.id, collection.id));

    job.status = 'completed';
    job.finishedAt = new Date().toISOString();
    this.jobs.set(collection.id, { ...job });
    this.logger.log(`Holder history scan completed for ${collection.id}. Transfers: ${job.processedTransfers}, wallets: ${job.touchedWallets}`);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout after ${ms}ms: ${label}`));
      }, ms);

      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
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

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function toHexBlock(block: number): string {
  return `0x${block.toString(16)}`;
}

function normalizeTokenId(tokenId?: string): string {
  if (!tokenId) return '0';
  if (tokenId.startsWith('0x')) {
    return BigInt(tokenId).toString();
  }
  return tokenId;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function ensureSummary(state: Map<string, MutableSummary>, address: string): MutableSummary {
  let summary = state.get(address);
  if (!summary) {
    summary = {
      currentBalance: 0,
      firstReceivedAt: null,
      firstReceivedBlock: null,
      lastReceivedAt: null,
      lastReceivedBlock: null,
      totalReceivedCount: 0,
      totalSentCount: 0,
    };
    state.set(address, summary);
  }
  return summary;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
