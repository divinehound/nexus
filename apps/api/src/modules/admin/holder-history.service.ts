import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { createPublicClient, decodeEventLog, getAddress, http, isAddress } from 'viem';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  type Database,
  collections,
  collectionHolderBalanceHistory,
  collectionHolderSummaries,
  collectionHolders,
} from '@nexus/database';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const transferEventAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: true, name: 'tokenId', type: 'uint256' },
    ],
  },
] as const;

@Injectable()
export class HolderHistoryService {
  private readonly logger = new Logger(HolderHistoryService.name);

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
    };
  }

  async scanCollectionHolderHistory(collectionId: string, input?: { fromBlock?: number }) {
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!collection) throw new NotFoundException('Collection not found');
    if (collection.chain === 'solana') {
      throw new BadRequestException('Holder history scan currently supports EVM collections only');
    }
    if (!isAddress(collection.contractAddress)) {
      throw new BadRequestException('Collection contract address is invalid for EVM log scanning');
    }

    const rpcUrl = this.config.get<string>('RPC_URL') || this.config.get<string>('BASE_RPC_URL') || this.config.get<string>('ETH_RPC_URL');
    const client = createPublicClient({ transport: http(rpcUrl) });

    const latestBlock = Number(await client.getBlockNumber());
    const fromBlock = input?.fromBlock ?? (collection.holderHistoryLastCheckedBlock ? collection.holderHistoryLastCheckedBlock + 1 : 0);

    const logs = await client.getLogs({
      address: getAddress(collection.contractAddress),
      event: transferEventAbi[0],
      fromBlock: BigInt(Math.max(fromBlock, 0)),
      toBlock: BigInt(latestBlock),
    });

    const existingSummaries = await this.db.query.collectionHolderSummaries.findMany({
      where: eq(collectionHolderSummaries.collectionId, collectionId),
    });

    const balanceMap = new Map(existingSummaries.map((row) => [row.address.toLowerCase(), row.currentBalance]));
    const summaryMap = new Map(existingSummaries.map((row) => [row.address.toLowerCase(), row]));
    const touched = new Set<string>();
    const historyRows: Array<typeof collectionHolderBalanceHistory.$inferInsert> = [];
    const blockCache = new Map<number, string>();

    for (const log of logs) {
      const decoded = decodeEventLog({ abi: transferEventAbi, data: log.data, topics: log.topics });
      const args = decoded.args as { from: `0x${string}`; to: `0x${string}`; tokenId: bigint };
      const from = args.from.toLowerCase();
      const to = args.to.toLowerCase();
      const tokenId = args.tokenId.toString();
      const blockNumber = Number(log.blockNumber ?? 0n);
      const logIndex = Number(log.logIndex ?? 0);
      const txHash = log.transactionHash ?? '';

      let blockTimestamp = blockCache.get(blockNumber);
      if (!blockTimestamp) {
        const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
        blockTimestamp = new Date(Number(block.timestamp) * 1000).toISOString();
        blockCache.set(blockNumber, blockTimestamp);
      }

      if (from !== ZERO_ADDRESS) {
        const nextBalance = Math.max((balanceMap.get(from) ?? 0) - 1, 0);
        balanceMap.set(from, nextBalance);
        touched.add(from);
        historyRows.push({
          collectionId,
          chain: collection.chain,
          address: from,
          blockNumber,
          blockTimestamp: new Date(blockTimestamp),
          transactionHash: txHash,
          logIndex,
          tokenId,
          direction: 'out',
          balanceAfter: nextBalance,
          counterpartyAddress: to,
        });
      }

      if (to !== ZERO_ADDRESS) {
        const nextBalance = (balanceMap.get(to) ?? 0) + 1;
        balanceMap.set(to, nextBalance);
        touched.add(to);
        historyRows.push({
          collectionId,
          chain: collection.chain,
          address: to,
          blockNumber,
          blockTimestamp: new Date(blockTimestamp),
          transactionHash: txHash,
          logIndex,
          tokenId,
          direction: 'in',
          balanceAfter: nextBalance,
          counterpartyAddress: from,
        });
      }
    }

    if (historyRows.length > 0) {
      await this.db.insert(collectionHolderBalanceHistory).values(historyRows).onConflictDoNothing();
    }

    const summaryRows: Array<typeof collectionHolderSummaries.$inferInsert> = [];
    const holderRows: Array<typeof collectionHolders.$inferInsert> = [];

    for (const address of touched) {
      const existing = summaryMap.get(address);
      const walletHistory = historyRows.filter((row) => row.address === address);
      const incoming = walletHistory.filter((row) => row.direction === 'in');
      const outgoing = walletHistory.filter((row) => row.direction === 'out');
      const firstIncoming = incoming[0];
      const lastIncoming = incoming[incoming.length - 1];
      const currentBalance = balanceMap.get(address) ?? 0;

      summaryRows.push({
        collectionId,
        chain: collection.chain,
        address,
        currentBalance,
        firstReceivedAt: existing?.firstReceivedAt ?? firstIncoming?.blockTimestamp ?? null,
        firstReceivedBlock: existing?.firstReceivedBlock ?? firstIncoming?.blockNumber ?? null,
        lastReceivedAt: lastIncoming?.blockTimestamp ?? existing?.lastReceivedAt ?? null,
        lastReceivedBlock: lastIncoming?.blockNumber ?? existing?.lastReceivedBlock ?? null,
        totalReceivedCount: (existing?.totalReceivedCount ?? 0) + incoming.length,
        totalSentCount: (existing?.totalSentCount ?? 0) + outgoing.length,
        updatedAt: new Date(),
      });

      holderRows.push({
        collectionId,
        chain: collection.chain,
        address,
        tokenCount: currentBalance,
        firstSeenAt: existing?.firstReceivedAt ?? firstIncoming?.blockTimestamp ?? new Date(),
        lastSeenAt: new Date(),
      });
    }

    if (summaryRows.length > 0) {
      await this.db.insert(collectionHolderSummaries).values(summaryRows).onConflictDoUpdate({
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

    if (holderRows.length > 0) {
      await this.db.insert(collectionHolders).values(holderRows).onConflictDoUpdate({
        target: [collectionHolders.collectionId, collectionHolders.address],
        set: {
          tokenCount: sql`excluded.token_count`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      });
    }

    await this.db
      .update(collections)
      .set({
        holderHistoryLastCheckedBlock: latestBlock,
        holderHistoryLastScannedAt: new Date(),
        holderCount: Array.from(balanceMap.values()).filter((v) => v > 0).length,
        lastIndexFinishedAt: new Date(),
        lastIndexStatus: 'success',
      })
      .where(eq(collections.id, collectionId));

    return {
      success: true,
      collection: collection.name,
      processedTransfers: logs.length,
      holdersIndexed: touched.size,
      fromBlock,
      toBlock: latestBlock,
    };
  }
}
