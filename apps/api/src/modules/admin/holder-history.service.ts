import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { alchemyNetwork } from '../../common/evm-chains';
import { HOLDER_HISTORY_SCAN_QUEUE } from '../../common/queue/queues';
import {
  type Database,
  collections,
  collectionHolderBalanceHistory,
  collectionHolderSummaries,
  collectionHolders,
  collectionHolderPnl,
  solanaIndexedMints,
  solanaRawSignatures,
  solanaParsedTransfers,
  projects,
} from '@nexus/database';
import { runAllParsers } from './solana-parsers';
import {
  deriveSalePrices,
  hasInternalTransfers,
  needsFallbackContext,
  needsTxValue,
  saleKey,
  supportsSalePrices,
  type SaleMovement,
  type SalePrice,
  type SaleReceipt,
} from './evm-sale-prices';
import { PnlAccumulator, type PnlTransfer } from './wallet-pnl';
import { PriceOracleService, nativeTokenForChain } from './price-oracle.service';

const LAMPORTS_PER_SOL = 1_000_000_000;

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
  mode?: 'alchemy_backfill' | 'helius_backfill' | 'solana_hybrid';
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

type SalePriceStats = {
  transactions: number;
  receiptsMissing: number;
  pricedTokens: number;
  errors: number;
  /** address → has contract code, shared across a scan's pages. */
  codeCache: Map<string, boolean>;
  /** Look up internal ETH payouts for non-Seaport sales (project opted in, chain supports it). */
  useInternalTransfers: boolean;
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

type SolanaMint = {
  mintAddress: string;
  currentOwner: string;
};

type HeliusTransaction = {
  signature?: string;
  timestamp?: number;
  slot?: number;
  tokenTransfers?: Array<{
    mint?: string;
    tokenAddress?: string;
    fromUserAccount?: string;
    toUserAccount?: string;
    fromTokenAccount?: string;
    toTokenAccount?: string;
    tokenAmount?: number;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
  }>;
  accountData?: Array<{
    account?: string;
    tokenBalanceChanges?: Array<{
      userAccount?: string;
      mint?: string;
      rawTokenAmount?: {
        tokenAmount?: string;
        decimals?: number;
      };
    }>;
  }>;
  events?: {
    nft?: {
      type?: string;
      source?: string;
      seller?: string;
      buyer?: string;
      nfts?: Array<{
        mint?: string;
      }>;
    };
  };
  instructions?: Array<{
    programId?: string;
    accounts?: string[];
    data?: string;
    innerInstructions?: Array<{
      programId?: string;
      accounts?: string[];
      data?: string;
    }>;
  }>;
};

@Injectable()
export class HolderHistoryService {
  private readonly logger = new Logger(HolderHistoryService.name);
  private readonly jobs = new Map<string, InMemoryScanJob>();

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
    @InjectQueue(HOLDER_HISTORY_SCAN_QUEUE) private readonly scanQueue: Queue,
    private readonly priceOracle: PriceOracleService,
  ) {}

  async getCollectionHolderHistory(collectionId: string) {
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!collection) throw new NotFoundException('Collection not found');

    const summaries = await this.db.query.collectionHolderSummaries.findMany({
      where: eq(collectionHolderSummaries.collectionId, collectionId),
      orderBy: [desc(collectionHolderSummaries.currentBalance), asc(collectionHolderSummaries.address)],
    });

    const history = await this.db.query.collectionHolderBalanceHistory.findMany({
      where: eq(collectionHolderBalanceHistory.collectionId, collectionId),
      orderBy: [asc(collectionHolderBalanceHistory.blockNumber), asc(collectionHolderBalanceHistory.logIndex)],
    });

    const pnlRows = await this.db.query.collectionHolderPnl.findMany({
      where: eq(collectionHolderPnl.collectionId, collectionId),
    });
    const pnlByAddress = new Map(pnlRows.map((p) => [p.address, p]));
    const nativeSymbol = pnlRows[0]?.nativeSymbol ?? nativeTokenForChain(collection.chain).symbol;

    // No history scan yet — fall back to the current-holder snapshot that
    // "Index Holders" writes to collection_holders. Balances are real; only
    // the transfer timeline (first/last received, per-wallet history) is
    // unavailable until a holder history scan runs.
    // Per-wallet PnL attached from collection_holder_pnl. Null when a wallet has
    // no computed PnL (e.g. snapshot-only data, or an older un-rescanned history).
    const pnlFor = (address: string) => {
      const p = pnlByAddress.get(address);
      if (!p) return null;
      return {
        nativeSymbol: p.nativeSymbol,
        buyCount: p.buyCount,
        sellCount: p.sellCount,
        realizedPnlNative: p.realizedPnlNative,
        realizedPnlUsd: p.realizedPnlUsd,
        unrealizedPnlNative: p.unrealizedPnlNative,
        unrealizedPnlUsd: p.unrealizedPnlUsd,
        totalBoughtNative: p.totalBoughtNative,
        totalSoldNative: p.totalSoldNative,
        costBasisRemainingNative: p.costBasisRemainingNative,
        avgHoldTimeSeconds: p.avgHoldTimeSeconds,
      };
    };

    let dataSource: 'history' | 'snapshot' | 'none' = summaries.length > 0 ? 'history' : 'none';
    let wallets: Array<{
      address: string;
      currentBalance: number;
      firstReceivedAt: Date | null;
      lastReceivedAt: Date | null;
      totalReceivedCount: number;
      totalSentCount: number;
      pnl: ReturnType<typeof pnlFor>;
    }> = summaries.map((s) => ({
      address: s.address,
      currentBalance: s.currentBalance,
      firstReceivedAt: s.firstReceivedAt,
      lastReceivedAt: s.lastReceivedAt,
      totalReceivedCount: s.totalReceivedCount,
      totalSentCount: s.totalSentCount,
      pnl: pnlFor(s.address),
    }));

    if (summaries.length === 0) {
      const snapshot = await this.db.query.collectionHolders.findMany({
        where: eq(collectionHolders.collectionId, collectionId),
        orderBy: [desc(collectionHolders.tokenCount), asc(collectionHolders.address)],
      });
      if (snapshot.length > 0) {
        dataSource = 'snapshot';
        wallets = snapshot.map((h) => ({
          address: h.address,
          currentBalance: h.tokenCount,
          firstReceivedAt: null,
          lastReceivedAt: null,
          totalReceivedCount: 0,
          totalSentCount: 0,
          pnl: pnlFor(h.address),
        }));
      }
    }

    // Collection-level PnL rollup across all wallets with computed PnL.
    const pnlTotals = pnlRows.reduce(
      (acc, p) => {
        acc.realizedPnlNative += p.realizedPnlNative;
        acc.realizedPnlUsd += p.realizedPnlUsd;
        acc.unrealizedPnlNative += p.unrealizedPnlNative;
        acc.unrealizedPnlUsd += p.unrealizedPnlUsd;
        acc.totalBuys += p.buyCount;
        acc.totalSells += p.sellCount;
        return acc;
      },
      { realizedPnlNative: 0, realizedPnlUsd: 0, unrealizedPnlNative: 0, unrealizedPnlUsd: 0, totalBuys: 0, totalSells: 0 },
    );

    const project = collection.projectId
      ? await this.db.query.projects.findFirst({
          columns: { id: true, name: true, exactSalePayouts: true },
          where: eq(projects.id, collection.projectId),
        })
      : null;

    return {
      collection,
      project: project ?? null,
      dataSource,
      summary: {
        wallets,
        totalWallets: wallets.filter((w) => w.currentBalance > 0).length,
        totalTokensHeld: wallets.reduce((sum, w) => sum + w.currentBalance, 0),
        pnl: {
          nativeSymbol,
          walletsWithPnl: pnlRows.length,
          // Durable coverage signal read straight off the ledger: how many
          // transfers carry a captured sale price (each priced sale has one
          // 'in' leg). 0 here means no prices are landing → PnL will be flat.
          pricedTransfers: history.filter((h) => h.priceNative != null && h.direction === 'in').length,
          ...pnlTotals,
        },
      },
      balanceHistory: history,
      scanJob: await this.scanJobFor(collection),
    };
  }

  /** Turn exact seller payouts (internal-transfer lookups for non-Seaport sales) on or off for the collection's project. */
  async setExactSalePayouts(collectionId: string, enabled: boolean) {
    const collection = await this.db.query.collections.findFirst({
      columns: { id: true, projectId: true },
      where: eq(collections.id, collectionId),
    });
    if (!collection) throw new NotFoundException('Collection not found');
    if (!collection.projectId) throw new BadRequestException('This collection is not in a project');
    const [updated] = await this.db
      .update(projects)
      .set({ exactSalePayouts: enabled })
      .where(eq(projects.id, collection.projectId))
      .returning({ id: projects.id, name: projects.name, exactSalePayouts: projects.exactSalePayouts });
    if (!updated) throw new NotFoundException('Project not found');
    return updated;
  }

  async queueCollectionHolderHistoryScan(collectionId: string, input?: { fromBlock?: number }) {
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });

    if (!collection) throw new NotFoundException('Collection not found');

    // Redis knows whether a scan is really queued or running (on any instance); this
    // instance's map can be stale, and a second add would be dropped by deduplication.
    if (await this.hasLiveScan(collectionId)) {
      const existing = this.jobs.get(collectionId);
      const job: InMemoryScanJob =
        existing && (existing.status === 'queued' || existing.status === 'running')
          ? existing
          : {
              collectionId,
              status: 'queued',
              fromBlock: collection.holderHistoryLastCheckedBlock ? collection.holderHistoryLastCheckedBlock + 1 : 0,
              processedTransfers: 0,
              touchedWallets: 0,
              mode: collection.chain === 'solana' ? 'solana_hybrid' : 'alchemy_backfill',
            };
      return { queued: true, alreadyRunning: true, job };
    }

    const fromBlock = input?.fromBlock ?? (collection.holderHistoryLastCheckedBlock ? collection.holderHistoryLastCheckedBlock + 1 : 0);
    const job: InMemoryScanJob = {
      collectionId,
      status: 'queued',
      fromBlock,
      processedTransfers: 0,
      touchedWallets: 0,
      mode: collection.chain === 'solana' ? 'solana_hybrid' : 'alchemy_backfill',
    };

    this.jobs.set(collectionId, job);
    this.logger.log(`Queued holder history scan for ${collectionId} from block ${fromBlock}`);

    // Durable BullMQ job; deduplication prevents concurrent scans of the
    // same collection even across API instances. A finished EVM scan saves
    // holder_history_last_checked_block, so the next one starts after it;
    // one that dies part way starts again from the previous checkpoint.
    await this.scanQueue.add(
      'scan',
      { collectionId, fromBlock },
      { deduplication: { id: collectionId } },
    );

    return { queued: true, alreadyRunning: false, job };
  }

  /**
   * This instance's view of the collection's scan, corrected by Redis (a scan queued or run
   * by another instance) and by the last scan's saved outcome.
   */
  private async scanJobFor(collection: typeof collections.$inferSelect) {
    const local = this.jobs.get(collection.id);
    const live = await this.hasLiveScan(collection.id);
    if (local && (local.status === 'queued' || local.status === 'running')) {
      if (live) return local;
    } else if (local) {
      return local;
    }
    if (live) return { collectionId: collection.id, status: 'queued' as const, fromBlock: (collection.holderHistoryLastCheckedBlock ?? -1) + 1, processedTransfers: 0, touchedWallets: 0 };
    if (collection.holderHistoryStatus === 'failed') {
      return { collectionId: collection.id, status: 'failed' as const, fromBlock: (collection.holderHistoryLastCheckedBlock ?? -1) + 1, processedTransfers: 0, touchedWallets: 0, error: collection.holderHistoryError ?? undefined };
    }
    return null;
  }

  /** True when a scan for the collection is waiting or running in the queue (from any API instance). */
  async hasLiveScan(collectionId: string): Promise<boolean> {
    const jobId = await this.scanQueue.getDeduplicationJobId(collectionId);
    if (!jobId) return false;
    const live = await this.scanQueue.getJob(jobId);
    if (!live) return false;
    const state = await live.getState();
    return state === 'waiting' || state === 'active' || state === 'delayed' || state === 'prioritized' || state === 'waiting-children';
  }

  async getCollectionHolderHistoryScanStatus(collectionId: string) {
    return this.jobs.get(collectionId) ?? { collectionId, status: 'idle' };
  }

  /**
   * Returns the reconciliation summary + list of mismatched mints for a Solana
   * collection. Used by the admin UI "Reconciliation" panel.
   */
  async getSolanaReconciliation(collectionId: string, mismatchLimit = 200) {
    const collection = await this.db.query.collections.findFirst({
      where: eq(collections.id, collectionId),
    });
    if (!collection) throw new NotFoundException('Collection not found');
    if (collection.chain !== 'solana') {
      throw new BadRequestException('Reconciliation is only available for Solana collections');
    }

    // Summary counts
    const statusRows = await this.db
      .select({
        status: solanaIndexedMints.reconciliationStatus,
        count: sql<number>`count(*)::int`,
      })
      .from(solanaIndexedMints)
      .where(eq(solanaIndexedMints.collectionId, collectionId))
      .groupBy(solanaIndexedMints.reconciliationStatus);

    const summary = { ok: 0, mismatch: 0, pending: 0, total: 0 };
    for (const row of statusRows) {
      const s = row.status as keyof typeof summary;
      if (s in summary) (summary as any)[s] = Number(row.count);
      summary.total += Number(row.count);
    }

    // Mismatch details
    const mismatches = await this.db.query.solanaIndexedMints.findMany({
      where: and(
        eq(solanaIndexedMints.collectionId, collectionId),
        eq(solanaIndexedMints.reconciliationStatus, 'mismatch'),
      ),
      limit: mismatchLimit,
      orderBy: [asc(solanaIndexedMints.mintAddress)],
    });

    // For each mismatched mint, fetch its parsed transfers so we can show the chain
    const mismatchDetails = await Promise.all(
      mismatches.map(async (mint) => {
        const transfers = await this.db.query.solanaParsedTransfers.findMany({
          where: and(
            eq(solanaParsedTransfers.collectionId, collectionId),
            eq(solanaParsedTransfers.mintAddress, mint.mintAddress),
          ),
          orderBy: [
            asc(solanaParsedTransfers.blockTime),
            asc(solanaParsedTransfers.slot),
            asc(solanaParsedTransfers.instructionOrder),
          ],
        });
        const signatures = await this.db.query.solanaRawSignatures.findMany({
          where: and(
            eq(solanaRawSignatures.collectionId, collectionId),
            eq(solanaRawSignatures.mintAddress, mint.mintAddress),
          ),
          orderBy: [asc(solanaRawSignatures.blockTime)],
          columns: {
            signature: true,
            blockTime: true,
            slot: true,
            parseStatus: true,
            transfersFound: true,
            errorMessage: true,
          },
        });
        return {
          mintAddress: mint.mintAddress,
          dasOwner: mint.currentOwner,
          computedOwner: transfers.length > 0 ? transfers[transfers.length - 1].toWallet : null,
          reconciliationNote: mint.reconciliationNote,
          signatureCount: signatures.length,
          signatures,
          transferCount: transfers.length,
          transfers,
        };
      }),
    );

    return { collection, summary, mismatches: mismatchDetails };
  }

  /**
   * Returns the stored raw_data for a specific signature (for debugging).
   */
  async getSolanaSignatureRawData(signature: string) {
    const row = await this.db.query.solanaRawSignatures.findFirst({
      where: eq(solanaRawSignatures.signature, signature),
    });
    if (!row) throw new NotFoundException('Signature not found in raw_signatures');

    const transfers = await this.db.query.solanaParsedTransfers.findMany({
      where: eq(solanaParsedTransfers.signature, signature),
    });

    return {
      signature: row.signature,
      mintAddress: row.mintAddress,
      blockTime: row.blockTime,
      slot: row.slot,
      parseStatus: row.parseStatus,
      transfersFound: row.transfersFound,
      lastParsedAt: row.lastParsedAt,
      errorMessage: row.errorMessage,
      rawData: row.rawData,
      parsedTransfers: transfers,
    };
  }

  /**
   * Marks the given signatures for re-parsing on the next scan. Used when a new
   * parser has been added and existing signatures should be re-run against it.
   */
  async markSolanaSignaturesForReview(collectionId: string, signatures: string[]) {
    if (signatures.length === 0) return { updated: 0 };
    const result = await this.db
      .update(solanaRawSignatures)
      .set({ parseStatus: 'needs_review' })
      .where(
        and(
          eq(solanaRawSignatures.collectionId, collectionId),
          inArray(solanaRawSignatures.signature, signatures),
        ),
      );
    return { updated: signatures.length, result: JSON.stringify(result ?? {}) };
  }

  /** Invoked by HolderHistoryScanProcessor (BullMQ worker). */
  async runCollectionHolderHistoryScan(collectionId: string, fromBlockInput?: number) {
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
      mode: collection.chain === 'solana' ? ('solana_hybrid' as const) : ('alchemy_backfill' as const),
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
          holderHistoryStatus: 'failed',
          holderHistoryError: error?.message || 'Unknown error',
          holderHistoryFailures: sql`${collections.holderHistoryFailures} + 1`,
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

    // A from-block-0 scan is a full rebuild: wipe prior history rows so
    // corrected data can be re-inserted past the unique index, and start
    // summary state fresh so replayed transfers don't double-count balances.
    const isFullRescan = fromBlock === 0;
    if (isFullRescan) {
      await this.db
        .delete(collectionHolderBalanceHistory)
        .where(eq(collectionHolderBalanceHistory.collectionId, collection.id));
    }

    const existingSummaries = isFullRescan
      ? []
      : await this.db.query.collectionHolderSummaries.findMany({
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
    const blockTimestampCache = new Map<number, Date>();
    let maxBlockNumber = collection.holderHistoryLastCheckedBlock ?? fromBlock;
    let pageKey: string | undefined;
    let page = 0;
    const network = this.getAlchemyNetwork(collection.chain);
    const endpoint = `https://${network}.g.alchemy.com/v2/${apiKey}`;

    // Sale prices aren't part of the erc721 transfer feed; each page's sale
    // transactions are read for them and attached by (txHash, tokenId).
    let transferRetries = 0;
    const project = collection.projectId
      ? await this.db.query.projects.findFirst({ columns: { exactSalePayouts: true }, where: eq(projects.id, collection.projectId) })
      : null;
    const saleStats: SalePriceStats = {
      transactions: 0,
      receiptsMissing: 0,
      pricedTokens: 0,
      errors: 0,
      codeCache: new Map(),
      // Opt-in per project: internal-transfer lookups cost ~2 extra Alchemy calls per non-Seaport sale.
      useInternalTransfers: !!project?.exactSalePayouts && hasInternalTransfers(collection.chain),
    };

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

      if ((response.status === 429 || response.status >= 500) && transferRetries < 5) {
        // Throttling (e.g. right after a burst of sale-price lookups): back off and retry this page.
        transferRetries += 1;
        await response.body?.cancel().catch(() => undefined);
        const delay = Math.min(2000 * Math.pow(2, transferRetries), 30000);
        this.logger.warn(`alchemy_getAssetTransfers page ${page}: HTTP ${response.status}, retrying in ${delay}ms`);
        await sleep(delay);
        page -= 1;
        continue;
      }
      transferRetries = 0;

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

      // Alchemy doesn't return metadata.blockTimestamp on every network
      // (e.g. Abstract). Resolve missing timestamps from the chain itself —
      // stamping transfers with the scan time would corrupt the history.
      const unresolvedBlocks = new Set<number>();
      for (const transfer of transfers) {
        const blockNumber = Number.parseInt(transfer.blockNum, 16);
        if (!parseBlockTimestamp(transfer.metadata?.blockTimestamp) && !blockTimestampCache.has(blockNumber)) {
          unresolvedBlocks.add(blockNumber);
        }
      }
      if (unresolvedBlocks.size > 0) {
        this.logger.warn(
          `Alchemy transfers missing blockTimestamp metadata for ${unresolvedBlocks.size} blocks on page ${page}; fetching via eth_getBlockByNumber`,
        );
        const fetched = await this.fetchBlockTimestamps(endpoint, Array.from(unresolvedBlocks));
        for (const [blockNumber, timestamp] of fetched) {
          blockTimestampCache.set(blockNumber, timestamp);
        }
      }

      const salePrices = await this.fetchEvmSalePricesForTransfers(collection, endpoint, transfers, saleStats);

      const historyRows: Array<typeof collectionHolderBalanceHistory.$inferInsert> = [];
      const perWalletLogIndex = new Map<string, number>();

      for (const transfer of transfers) {
        const from = (transfer.from || '').toLowerCase();
        const to = (transfer.to || '').toLowerCase();
        const tokenId = normalizeTokenId(transfer.erc721TokenId);
        const txHash = transfer.hash;
        const blockNumber = Number.parseInt(transfer.blockNum, 16);
        const blockTimestamp = parseBlockTimestamp(transfer.metadata?.blockTimestamp) ?? blockTimestampCache.get(blockNumber);
        if (!blockTimestamp) {
          throw new Error(`Could not resolve timestamp for block ${blockNumber} (tx ${txHash})`);
        }
        maxBlockNumber = Math.max(maxBlockNumber, blockNumber);

        // The seller's leg records net proceeds (after marketplace fee + royalty);
        // the buyer's leg records the gross all-in cost basis.
        const salePrice = salePrices.get(`${txHash.toLowerCase()}:${saleKey({ tokenId, from, to })}`) ?? null;

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
            priceNative: salePrice ? salePrice.sellerNet : null,
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
            priceNative: salePrice ? salePrice.gross : null,
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

    // Always log the outcome — a silent zero was how the getNFTSales outage went unnoticed.
    this.logger.log(
      `[EVM] sale prices for ${collection.id}: ${saleStats.pricedTokens} priced transfers from ${saleStats.transactions} wallet-to-wallet transactions` +
        (saleStats.receiptsMissing ? `, ${saleStats.receiptsMissing} receipts unavailable` : '') +
        (saleStats.errors ? `, ${saleStats.errors} lookups failed (see above)` : '') +
        (supportsSalePrices(collection.chain) ? '' : ` (no sale pricing for chain ${collection.chain})`) +
        (saleStats.useInternalTransfers ? ', exact seller payouts on' : ''),
    );

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

    const solanaRpcUrl = this.getSolanaRpcUrl();
    if (!solanaRpcUrl) {
      throw new Error('SOLANA_RPC_URL or HELIUS_API_KEY required for Solana indexing');
    }

    // =====================================================================
    // PHASE 1: Asset Discovery
    // =====================================================================
    // Always re-runs. Upserts every asset from DAS getAssetsByGroup so new
    // mints and ownership changes are reflected on every scan.
    this.logger.log(`[Solana] Phase 1: Discovering assets for ${collection.contractAddress}`);
    const mints = await this.discoverSolanaMints(collection.contractAddress, heliusApiKey);
    this.logger.log(`[Solana] Phase 1: ${mints.length} assets from DAS`);

    for (const batch of chunkArray(mints, 500)) {
      await this.db
        .insert(solanaIndexedMints)
        .values(
          batch.map((m) => ({
            collectionId: collection.id,
            mintAddress: m.mintAddress,
            currentOwner: m.currentOwner || null,
            sigCollectionStatus: 'pending',
          })),
        )
        .onConflictDoUpdate({
          target: [solanaIndexedMints.collectionId, solanaIndexedMints.mintAddress],
          set: { currentOwner: sql`excluded.current_owner` },
        });
    }

    const dbMints = await this.db.query.solanaIndexedMints.findMany({
      where: eq(solanaIndexedMints.collectionId, collection.id),
    });
    const mintAddressSet = new Set(dbMints.map((m) => m.mintAddress));
    this.logger.log(`[Solana] Phase 1 complete: ${dbMints.length} assets persisted`);

    // =====================================================================
    // PHASE 2: Signature Collection (incremental, per-mint)
    // =====================================================================
    // For each asset, call getSignaturesForAddress with `until` set to the
    // newest signature we already have for THAT SPECIFIC mint. This gives us
    // correct incremental semantics and avoids the cross-mint collision that
    // happens when using a collection-wide "known signatures" set.
    this.logger.log(`[Solana] Phase 2: Collecting signatures for ${dbMints.length} assets`);

    // Build a map of mint → newest known signature (for incremental scans)
    const newestByMint = new Map<string, string>();
    const newestRows = await this.db
      .select({
        mintAddress: solanaRawSignatures.mintAddress,
        signature: solanaRawSignatures.signature,
        blockTime: solanaRawSignatures.blockTime,
      })
      .from(solanaRawSignatures)
      .where(eq(solanaRawSignatures.collectionId, collection.id))
      .orderBy(desc(solanaRawSignatures.blockTime));
    for (const row of newestRows) {
      // orderBy desc means first seen per mint = newest
      if (!newestByMint.has(row.mintAddress)) {
        newestByMint.set(row.mintAddress, row.signature);
      }
    }

    let newSigCount = 0;
    for (let i = 0; i < dbMints.length; i++) {
      const mint = dbMints[i];
      try {
        const untilSig = newestByMint.get(mint.mintAddress);
        const entries = await this.collectSignaturesWithMetadata(mint.mintAddress, solanaRpcUrl, untilSig);
        if (entries.length > 0) {
          for (const batch of chunkArray(entries, 500)) {
            await this.db
              .insert(solanaRawSignatures)
              .values(
                batch.map((e) => ({
                  collectionId: collection.id,
                  mintAddress: mint.mintAddress,
                  signature: e.signature,
                  blockTime: e.blockTime ? new Date(e.blockTime * 1000) : null,
                  slot: e.slot,
                  parseStatus: 'pending',
                })),
              )
              .onConflictDoNothing();
            newSigCount += batch.length;
          }
        }
        await this.db
          .update(solanaIndexedMints)
          .set({ sigCollectionStatus: 'complete', sigCount: entries.length })
          .where(
            and(
              eq(solanaIndexedMints.collectionId, collection.id),
              eq(solanaIndexedMints.mintAddress, mint.mintAddress),
            ),
          );
      } catch (err: any) {
        this.logger.warn(`[Solana] Phase 2: Failed to collect signatures for ${mint.mintAddress}: ${err?.message || err}`);
      }

      await sleep(500);
      if ((i + 1) % 100 === 0 || i === dbMints.length - 1) {
        this.logger.log(`[Solana] Phase 2 progress: ${i + 1}/${dbMints.length} assets, ${newSigCount} new signatures`);
      }
    }
    this.logger.log(`[Solana] Phase 2 complete: ${newSigCount} new signatures collected`);

    // =====================================================================
    // PHASE 3: Parse signatures (pending + needs_review)
    // =====================================================================
    // Fetches raw data via Helius batch parse, stores it in raw_data JSONB,
    // runs all parsers, inserts found transfers into solana_parsed_transfers.
    // Only processes pending/needs_review rows; success/failed are skipped.
    this.logger.log(`[Solana] Phase 3: Parsing signatures via Helius batch endpoint`);
    const parserCtx = { mintAddresses: mintAddressSet };
    let totalParsedThisRun = 0;
    let totalTransfersFound = 0;

    while (true) {
      const toParse = await this.db.query.solanaRawSignatures.findMany({
        where: and(
          eq(solanaRawSignatures.collectionId, collection.id),
          or(
            eq(solanaRawSignatures.parseStatus, 'pending'),
            eq(solanaRawSignatures.parseStatus, 'needs_review'),
          ),
        ),
        limit: 100,
      });
      if (toParse.length === 0) break;

      const signatures = toParse.map((s) => s.signature);

      // Delete any existing parsed_transfer rows for these signatures before
      // re-running parsers. This is essential for re-parses (parse_status =
      // needs_review): without deletion, onConflictDoNothing would treat the
      // re-insert as a no-op, leaving stale rows from removed/fixed parsers
      // and rows with outdated instruction_order defaults.
      await this.db
        .delete(solanaParsedTransfers)
        .where(
          and(
            eq(solanaParsedTransfers.collectionId, collection.id),
            inArray(solanaParsedTransfers.signature, signatures),
          ),
        );

      let parsed: any[] = [];
      try {
        parsed = await this.heliusBatchParseWithRetry(signatures, heliusApiKey, 0);
      } catch (err: any) {
        this.logger.error(`[Solana] Phase 3: batch parse failed: ${err?.message || err}`);
        // mark this batch as failed so we can retry later
        for (const sig of toParse) {
          await this.db
            .update(solanaRawSignatures)
            .set({ parseStatus: 'failed', errorMessage: err?.message || 'batch parse error', lastParsedAt: new Date() })
            .where(eq(solanaRawSignatures.id, sig.id));
        }
        await sleep(5000);
        continue;
      }

      // Build a map signature → parsed tx so we can match to the DB rows
      const parsedBySig = new Map<string, any>();
      for (const tx of parsed) {
        if (tx?.signature) parsedBySig.set(tx.signature, tx);
      }

      const transfersToInsert: Array<typeof solanaParsedTransfers.$inferInsert> = [];
      const sigUpdates: Array<{ id: string; status: string; rawData: any; transfersFound: number; error: string | null; blockTime: Date | null; slot: number | null }> = [];

      for (const sigRow of toParse) {
        const tx = parsedBySig.get(sigRow.signature);
        if (!tx) {
          // Helius didn't return anything for this signature
          sigUpdates.push({
            id: sigRow.id,
            status: 'failed',
            rawData: null,
            transfersFound: 0,
            error: 'no response from helius batch parse',
            blockTime: sigRow.blockTime,
            slot: sigRow.slot,
          });
          continue;
        }

        const transfers = runAllParsers(tx, parserCtx);
        const txBlockTime = tx.timestamp ? new Date(tx.timestamp * 1000) : sigRow.blockTime;
        const txSlot = tx.slot ?? sigRow.slot ?? 0;
        if (!txBlockTime && transfers.length > 0) {
          this.logger.warn(`[Solana] No blockTime for ${sigRow.signature}; falling back to scan time`);
        }

        // Assign sequential instructionOrder based on extraction order.
        // runAllParsers preserves the order each parser found its transfers,
        // and within a parser the walker iterates instructions in execution
        // order. This gives us a deterministic intra-tx ordering that we
        // can later sort by — critical for txs with multiple TransferV1
        // inner instructions (e.g. Magic Eden V2 CoreSell: seller→escrow
        // followed by escrow→buyer in the same signature).
        transfers.forEach((t, idx) => {
          transfersToInsert.push({
            collectionId: collection.id,
            signature: sigRow.signature,
            mintAddress: t.mintAddress,
            fromWallet: t.fromWallet || null,
            toWallet: t.toWallet || null,
            blockTime: txBlockTime ?? new Date(),
            slot: txSlot,
            instructionOrder: idx,
            parserName: t.parserName,
            programId: t.programId,
            priceLamports: t.priceLamports ?? null,
          });
        });

        sigUpdates.push({
          id: sigRow.id,
          status: 'success',
          rawData: tx,
          transfersFound: transfers.length,
          error: null,
          blockTime: txBlockTime,
          slot: txSlot,
        });
      }

      // Insert transfers (dedup by unique index)
      if (transfersToInsert.length > 0) {
        for (const batch of chunkArray(transfersToInsert, 500)) {
          await this.db.insert(solanaParsedTransfers).values(batch).onConflictDoNothing();
        }
        totalTransfersFound += transfersToInsert.length;
      }

      // Update signature statuses
      for (const upd of sigUpdates) {
        await this.db
          .update(solanaRawSignatures)
          .set({
            parseStatus: upd.status,
            rawData: upd.rawData,
            transfersFound: upd.transfersFound,
            errorMessage: upd.error,
            lastParsedAt: new Date(),
            blockTime: upd.blockTime,
            slot: upd.slot,
          })
          .where(eq(solanaRawSignatures.id, upd.id));
      }

      totalParsedThisRun += toParse.length;
      this.logger.log(
        `[Solana] Phase 3 progress: +${toParse.length} sigs, ${transfersToInsert.length} transfers this batch, ${totalTransfersFound} total`,
      );
      await sleep(500); // rate limit
    }
    this.logger.log(
      `[Solana] Phase 3 complete: parsed ${totalParsedThisRun} sigs this run, ${totalTransfersFound} transfers extracted`,
    );

    // =====================================================================
    // PHASE 4: Rebuild balance history from parsed transfers
    // =====================================================================
    // Deletes all existing balance history rows, reads all parsed transfers
    // sorted chronologically, and reconstructs the running balance state.
    this.logger.log(`[Solana] Phase 4: Rebuilding balance history from parsed transfers`);
    await this.db
      .delete(collectionHolderBalanceHistory)
      .where(eq(collectionHolderBalanceHistory.collectionId, collection.id));

    const allTransfers = await this.db.query.solanaParsedTransfers.findMany({
      where: eq(solanaParsedTransfers.collectionId, collection.id),
      orderBy: [
        asc(solanaParsedTransfers.blockTime),
        asc(solanaParsedTransfers.slot),
        asc(solanaParsedTransfers.instructionOrder),
      ],
    });
    this.logger.log(`[Solana] Phase 4: Processing ${allTransfers.length} transfers chronologically`);

    const summaryState = new Map<string, MutableSummary>();
    const touched = new Set<string>();
    const perWalletLogIndex = new Map<string, number>();
    const historyRows: Array<typeof collectionHolderBalanceHistory.$inferInsert> = [];
    let maxSlot = 0;

    for (const t of allTransfers) {
      const slot = t.slot ?? 0;
      if (slot > maxSlot) maxSlot = slot;
      const timestamp = t.blockTime;
      const from = t.fromWallet || '';
      const to = t.toWallet || '';
      const sig = t.signature;
      // Same sale price applies to both legs (seller proceeds / buyer cost).
      const priceNative = t.priceLamports ? t.priceLamports / LAMPORTS_PER_SOL : null;

      if (from) {
        const summary = ensureSummary(summaryState, from);
        summary.currentBalance = Math.max(summary.currentBalance - 1, 0);
        summary.totalSentCount += 1;
        touched.add(from);
        const key = `${sig}:${from}`;
        const logIndex = (perWalletLogIndex.get(key) ?? 0) + 1;
        perWalletLogIndex.set(key, logIndex);
        historyRows.push({
          collectionId: collection.id,
          chain: collection.chain,
          address: from,
          blockNumber: slot,
          blockTimestamp: timestamp,
          transactionHash: sig,
          logIndex,
          tokenId: t.mintAddress,
          direction: 'out',
          balanceAfter: summary.currentBalance,
          counterpartyAddress: to || null,
          priceNative,
        });
      }

      if (to) {
        const summary = ensureSummary(summaryState, to);
        summary.currentBalance += 1;
        summary.totalReceivedCount += 1;
        if (!summary.firstReceivedAt || (summary.firstReceivedBlock ?? Number.MAX_SAFE_INTEGER) > slot) {
          summary.firstReceivedAt = timestamp;
          summary.firstReceivedBlock = slot;
        }
        summary.lastReceivedAt = timestamp;
        summary.lastReceivedBlock = slot;
        touched.add(to);
        const key = `${sig}:${to}`;
        const logIndex = (perWalletLogIndex.get(key) ?? 0) + 1;
        perWalletLogIndex.set(key, logIndex);
        historyRows.push({
          collectionId: collection.id,
          chain: collection.chain,
          address: to,
          blockNumber: slot,
          blockTimestamp: timestamp,
          transactionHash: sig,
          logIndex,
          tokenId: t.mintAddress,
          direction: 'in',
          balanceAfter: summary.currentBalance,
          counterpartyAddress: from || null,
          priceNative,
        });
      }

      if (historyRows.length >= 1000) {
        await this.persistHistoryBatch(historyRows);
        historyRows.length = 0;
      }
    }
    await this.persistHistoryBatch(historyRows);
    historyRows.length = 0;

    this.logger.log(`[Solana] Phase 4 complete: built balance history for ${touched.size} wallets`);

    // =====================================================================
    // PHASE 5: Reconcile computed state against DAS current ownership
    // =====================================================================
    // For each asset, compute its final owner by walking transfers in order.
    // Compare against DAS current_owner. Mark mismatches for investigation.
    this.logger.log(`[Solana] Phase 5: Reconciling computed state vs DAS ownership`);

    // Group transfers by mint, get final owner (last 'to' in chronological order)
    const computedOwnerByMint = new Map<string, string>();
    for (const t of allTransfers) {
      if (t.toWallet) computedOwnerByMint.set(t.mintAddress, t.toWallet);
      // Note: if to is null/empty (burn), the mint has no owner
      else if (t.fromWallet) computedOwnerByMint.delete(t.mintAddress);
    }

    let okCount = 0;
    let mismatchCount = 0;
    let noHistoryCount = 0;
    const reconcileUpdates: Array<{ mintAddress: string; status: string; note: string | null }> = [];

    for (const mint of dbMints) {
      const dasOwner = (mint.currentOwner || '').trim();
      const computedRaw = computedOwnerByMint.get(mint.mintAddress);
      const computed = (computedRaw || '').trim();

      if (!computed) {
        // No transfers detected for this mint. If DAS shows an owner, we have
        // an incomplete picture — probably missing the initial mint event.
        if (dasOwner) {
          noHistoryCount++;
          reconcileUpdates.push({
            mintAddress: mint.mintAddress,
            status: 'mismatch',
            note: `No transfers detected; DAS owner=${dasOwner}`,
          });
        } else {
          reconcileUpdates.push({ mintAddress: mint.mintAddress, status: 'ok', note: null });
        }
        continue;
      }

      if (computed === dasOwner) {
        okCount++;
        reconcileUpdates.push({ mintAddress: mint.mintAddress, status: 'ok', note: null });
      } else {
        mismatchCount++;
        // Diagnostic: include lengths and char codes at any diff positions
        // so truly subtle differences (whitespace, case, unicode) surface.
        const diffInfo =
          computed.length !== dasOwner.length
            ? ` lenDiff(${computed.length} vs ${dasOwner.length})`
            : '';
        reconcileUpdates.push({
          mintAddress: mint.mintAddress,
          status: 'mismatch',
          note: `Computed=${computed} DAS=${dasOwner}${diffInfo}`,
        });
      }
    }

    // Batch update reconciliation status
    for (const batch of chunkArray(reconcileUpdates, 200)) {
      for (const upd of batch) {
        await this.db
          .update(solanaIndexedMints)
          .set({ reconciliationStatus: upd.status, reconciliationNote: upd.note })
          .where(
            and(
              eq(solanaIndexedMints.collectionId, collection.id),
              eq(solanaIndexedMints.mintAddress, upd.mintAddress),
            ),
          );
      }
    }

    this.logger.log(
      `[Solana] Phase 5 complete: ${okCount} ok, ${mismatchCount} mismatched, ${noHistoryCount} no-history`,
    );

    // Final: persist summaries and holders
    job.processedTransfers = allTransfers.length;
    job.touchedWallets = touched.size;
    job.toBlock = maxSlot;
    this.jobs.set(collection.id, { ...job });

    this.logger.log(
      `[Solana] Scan complete: ${allTransfers.length} transfers, ${touched.size} wallets, reconciliation ${okCount} ok / ${mismatchCount} mismatch`,
    );

    await this.persistFinalHolderState(collection, summaryState, touched, maxSlot, job);
  }

  private async collectSignaturesWithMetadata(
    mintAddress: string,
    rpcUrl: string,
    untilSignature?: string,
  ): Promise<Array<{ signature: string; slot: number; blockTime: number | null }>> {
    // Use Solana RPC's `until` parameter to bound the search at the newest
    // signature we already have for THIS mint. This is per-mint, so cross-mint
    // signature collisions don't cause us to stop too early.
    //
    // First-time collection (no untilSignature): walks backward paging through
    // `before` until the end of available history.
    //
    // Incremental: returns only signatures newer than the stored newest,
    // stopping automatically when the RPC hits our `until` marker.
    const results: Array<{ signature: string; slot: number; blockTime: number | null }> = [];
    let before: string | undefined;

    while (true) {
      const params: Record<string, unknown> = { limit: 1000, commitment: 'finalized' };
      if (before) params.before = before;
      if (untilSignature) params.until = untilSignature;

      const result = await this.solanaRpcCallWithRetry(rpcUrl, 'getSignaturesForAddress', [mintAddress, params], 0);
      const entries = (result ?? []) as Array<{
        signature: string;
        slot: number;
        blockTime: number | null;
        err: unknown;
      }>;

      for (const entry of entries) {
        if (entry.err) continue;
        results.push({ signature: entry.signature, slot: entry.slot, blockTime: entry.blockTime });
      }

      if (entries.length < 1000) break;
      before = entries[entries.length - 1].signature;
    }

    return results;
  }

  private getSolanaRpcUrl(): string {
    // Prefer explicit SOLANA_RPC_URL (e.g. Alchemy Solana, QuickNode)
    const explicit = this.config.get<string>('solana.rpcUrl');
    if (explicit) return explicit;
    // Fall back to Helius RPC which supports standard Solana JSON-RPC methods.
    // The ALCHEMY_API_KEY is typically EVM-only and won't work on Alchemy's Solana endpoint.
    const heliusKey = this.config.get<string>('HELIUS_API_KEY');
    if (heliusKey) return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
    return '';
  }

  private async discoverSolanaMints(collectionAddress: string, heliusApiKey: string): Promise<SolanaMint[]> {
    const mints: SolanaMint[] = [];
    let page = 1;

    while (true) {
      if (page > 1) await sleep(500); // Respect 2 req/s DAS rate limit

      const response = await this.withTimeout(
        fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: page,
            method: 'getAssetsByGroup',
            params: {
              groupKey: 'collection',
              groupValue: collectionAddress,
              page,
              limit: 1000,
            },
          }),
        }),
        30000,
        `helius getAssetsByGroup page ${page}`,
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Helius getAssetsByGroup failed (${response.status}): ${text}`);
      }

      const data = (await response.json()) as {
        result?: { items?: SolanaAsset[] };
        error?: { message?: string };
      };

      if (data.error) {
        throw new Error(data.error.message || 'Helius getAssetsByGroup error');
      }

      const assets = data.result?.items ?? [];
      for (const asset of assets) {
        mints.push({
          mintAddress: asset.id,
          currentOwner: asset.ownership?.owner || '',
        });
      }

      this.logger.log(`[Solana Hybrid] Mint discovery page ${page}: ${assets.length} assets (${mints.length} total)`);

      if (assets.length < 1000) break;
      page++;
    }

    return mints;
  }

  private async collectSignaturesForMint(
    mintAddress: string,
    rpcUrl: string,
    knownSignatures: Set<string>,
  ): Promise<{ signatures: string[]; oldestBlockTime: number | null; oldestSlot: number | null }> {
    const signatures: string[] = [];
    let oldestBlockTime: number | null = null;
    let oldestSlot: number | null = null;
    let before: string | undefined;

    while (true) {
      const params: Record<string, unknown> = { limit: 1000, commitment: 'finalized' };
      if (before) params.before = before;

      const result = await this.solanaRpcCallWithRetry(rpcUrl, 'getSignaturesForAddress', [mintAddress, params], 0);

      const entries = (result ?? []) as Array<{
        signature: string;
        slot: number;
        blockTime: number | null;
        err: unknown;
      }>;

      let hitKnown = false;
      for (const entry of entries) {
        // Track oldest blockTime and slot across all entries (the mint event)
        if (entry.blockTime !== null && (oldestBlockTime === null || entry.blockTime < oldestBlockTime)) {
          oldestBlockTime = entry.blockTime;
          oldestSlot = entry.slot;
        }
        if (entry.err) continue; // Skip failed transactions
        if (knownSignatures.has(entry.signature)) {
          hitKnown = true;
          break;
        }
        signatures.push(entry.signature);
      }

      if (hitKnown || entries.length < 1000) break;
      before = entries[entries.length - 1].signature;
    }

    return { signatures, oldestBlockTime, oldestSlot };
  }

  private async solanaRpcCallWithRetry(
    rpcUrl: string,
    method: string,
    params: unknown[],
    attempt: number,
  ): Promise<unknown> {
    const response = await this.withTimeout(
      fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
      30000,
      `RPC ${method}`,
    );

    // Helius returns 413 (with -32413 body) or 429 for rate limiting
    if (response.status === 429 || response.status === 413) {
      if (attempt >= 7) {
        throw new Error(`RPC ${method} rate limited after ${attempt} retries`);
      }
      const delay = Math.min(2000 * Math.pow(2, attempt), 60000);
      this.logger.warn(`RPC rate limited (${response.status}) for ${method}, retrying in ${delay}ms (attempt ${attempt + 1})`);
      await sleep(delay);
      return this.solanaRpcCallWithRetry(rpcUrl, method, params, attempt + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`RPC ${method} failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (data.error) {
      throw new Error(`RPC ${method} error: ${data.error.message || 'Unknown'}`);
    }

    return data.result;
  }


  /**
   * Fetches block timestamps via batched eth_getBlockByNumber. Used when
   * alchemy_getAssetTransfers omits metadata.blockTimestamp (chain-dependent).
   */
  private async fetchBlockTimestamps(endpoint: string, blockNumbers: number[]): Promise<Map<number, Date>> {
    const timestamps = new Map<number, Date>();
    let pending = [...blockNumbers];
    let lastError: string | null = null;

    // Individual items inside a JSON-RPC batch can fail (throttling, transient
    // node errors) even when the HTTP request succeeds, so retry unresolved
    // blocks across rounds instead of failing the whole scan on first miss.
    for (let round = 0; round < 6 && pending.length > 0; round++) {
      if (round > 0) {
        const delay = Math.min(1000 * Math.pow(2, round), 15000);
        this.logger.warn(
          `eth_getBlockByNumber: ${pending.length} blocks unresolved (${lastError ?? 'no error returned'}), retrying in ${delay}ms`,
        );
        await sleep(delay);
      }

      const stillPending: number[] = [];
      // eth_getBlockByNumber costs ~16 CUs; keep each batch under the free
      // tier's ~330 CU/s throughput cap so items resolve on the first try
      // instead of churning through per-item 429 retry rounds.
      for (const batch of chunkArray(pending, 20)) {
        const payload = batch.map((blockNumber) => ({
          jsonrpc: '2.0',
          id: blockNumber,
          method: 'eth_getBlockByNumber',
          params: [toHexBlock(blockNumber), false],
        }));

        const responses = await this.evmRpcBatchWithRetry(endpoint, payload, 0);
        const resolved = new Set<number>();
        for (const entry of responses) {
          const timestampHex = entry?.result?.timestamp;
          if (typeof entry?.id === 'number' && typeof timestampHex === 'string') {
            timestamps.set(entry.id, new Date(Number.parseInt(timestampHex, 16) * 1000));
            resolved.add(entry.id);
          } else if (entry?.error) {
            lastError = `code ${entry.error.code}: ${entry.error.message}`;
          }
        }
        for (const blockNumber of batch) {
          if (!resolved.has(blockNumber)) stillPending.push(blockNumber);
        }
        await sleep(1000);
      }

      pending = stillPending;
    }

    if (pending.length > 0) {
      throw new Error(
        `Failed to resolve timestamps for ${pending.length} blocks after retries (first: ${pending[0]}, last error: ${lastError ?? 'none returned'})`,
      );
    }

    return timestamps;
  }

  private async evmRpcBatchWithRetry<R = { timestamp?: string }>(
    endpoint: string,
    payload: Array<Record<string, unknown>>,
    attempt: number,
    label = `eth_getBlockByNumber batch (${payload.length} blocks)`,
  ): Promise<Array<{ id?: unknown; result?: R | null; error?: { code?: number; message?: string } }>> {
    const response = await this.withTimeout(
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      30000,
      label,
    );

    if (response.status === 429 || response.status >= 500) {
      if (attempt >= 5) {
        throw new Error(`${label} failed (${response.status}) after retries`);
      }
      await response.body?.cancel().catch(() => undefined);
      const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
      this.logger.warn(`${label}: HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1})`);
      await sleep(delay);
      return this.evmRpcBatchWithRetry<R>(endpoint, payload, attempt + 1, label);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${label} failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      // A single object back from a batch request is a top-level error
      // (e.g. the endpoint rejecting batching) — surface it, don't parse it.
      const message = (data as { error?: { message?: string } })?.error?.message;
      throw new Error(`${label} returned non-array response: ${message ?? JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
  }

  /** One JSON-RPC call, shaped like a one-item batch response. Per-call errors come back as rows. */
  private async evmRpcSingleWithRetry<R>(
    endpoint: string,
    payload: Record<string, unknown>,
    label: string,
  ): Promise<Array<{ id?: unknown; result?: R | null; error?: { code?: number; message?: string } }>> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.withTimeout(
        fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
        30000,
        label,
      );
      if ((response.status === 429 || response.status >= 500) && attempt < 5) {
        await response.body?.cancel().catch(() => undefined);
        await sleep(Math.min(2000 * Math.pow(2, attempt), 30000));
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${label} failed (${response.status}): ${text.slice(0, 300)}`);
      }
      return [(await response.json()) as { id?: unknown; result?: R | null; error?: { code?: number; message?: string } }];
    }
  }

  /**
   * Runs one JSON-RPC method over many params as batched calls. Items that come
   * back with an error or no result (per-item throttling) are retried in later
   * rounds; anything still missing after that is simply absent from the map.
   */
  private async evmRpcMany<R>(
    endpoint: string,
    method: string,
    keys: string[],
    paramsFor: (key: string) => unknown[],
    batchSize = 20,
    pauseMs = 1000,
  ): Promise<Map<string, R>> {
    const results = new Map<string, R>();
    let pending = [...keys];
    let lastError: string | null = null;
    for (let round = 0; round < 4 && pending.length > 0; round++) {
      if (round > 0) {
        const delay = Math.min(1000 * Math.pow(2, round), 15000);
        this.logger.warn(`${method}: ${pending.length} unresolved (${lastError ?? 'no error returned'}), retrying in ${delay}ms`);
        await sleep(delay);
      }
      const stillPending: string[] = [];
      const batches = chunkArray(pending, batchSize);
      for (const [batchIndex, batch] of batches.entries()) {
        const payload = batch.map((key, id) => ({ jsonrpc: '2.0', id, method, params: paramsFor(key) }));
        const rows =
          batchSize === 1
            ? await this.evmRpcSingleWithRetry<R>(endpoint, payload[0], `${method}`)
            : await this.evmRpcBatchWithRetry<R>(endpoint, payload, 0, `${method} batch (${batch.length})`);
        const resolved = new Set<number>();
        for (const row of rows) {
          if (typeof row?.id === 'number' && row.id < batch.length && row.result != null) {
            results.set(batch[row.id], row.result);
            resolved.add(row.id);
          } else if (row?.error) {
            lastError = `code ${row.error.code}: ${row.error.message}`;
          }
        }
        batch.forEach((key, i) => {
          if (!resolved.has(i)) stillPending.push(key);
        });
        // Keep under the free tier's compute-unit throughput (~20 receipts at
        // ~20 CU each per second), so the transfer feed isn't throttled after.
        if (batchIndex < batches.length - 1) await sleep(pauseMs);
      }
      pending = stillPending;
    }
    if (pending.length > 0) {
      this.logger.warn(`${method}: gave up on ${pending.length} of ${keys.length} after retries (last error: ${lastError ?? 'none returned'})`);
    }
    return results;
  }

  private async heliusBatchParseWithRetry(
    signatures: string[],
    apiKey: string,
    attempt: number,
  ): Promise<HeliusTransaction[]> {
    const response = await this.withTimeout(
      fetch(`https://api.helius.xyz/v0/transactions?api-key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: signatures }),
      }),
      30000,
      'helius batch parse',
    );

    if (response.status === 429) {
      if (attempt >= 5) {
        throw new Error('Helius batch parse rate limited after retries');
      }
      const delay = Math.min(5000 * (attempt + 1), 30000);
      this.logger.warn(`Helius batch parse rate limited, retrying in ${delay}ms (attempt ${attempt + 1})`);
      await sleep(delay);
      return this.heliusBatchParseWithRetry(signatures, apiKey, attempt + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Helius batch parse failed (${response.status}): ${text}`);
    }

    return (await response.json()) as HeliusTransaction[];
  }


  private async getKnownTransactionHashesForCollection(collectionId: string): Promise<Set<string>> {
    const rows = await this.db.query.collectionHolderBalanceHistory.findMany({
      where: eq(collectionHolderBalanceHistory.collectionId, collectionId),
      columns: { transactionHash: true },
    });

    return new Set(rows.map((row) => row.transactionHash));
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
    // Wallets whose balance reached 0: they've left, so they come out of
    // collection_holders (overlap, graph and discovery count its rows).
    const exitedAddresses: string[] = [];

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

      if (summary.currentBalance <= 0) {
        if (touched.has(address)) exitedAddresses.push(address);
        continue;
      }

      holderRows.push({
        collectionId: collection.id,
        chain: collection.chain,
        address,
        tokenCount: summary.currentBalance,
        firstSeenAt: summary.firstReceivedAt ?? new Date(),
        lastSeenAt: new Date(),
      });
    }

    // One transaction: summaries and the checkpoint move together, so a crash between them
    // can't make the next incremental scan replay transfers into already-updated balances.
    await this.db.transaction(async (tx) => {
      if (summaryRows.length > 0) {
        for (const batch of chunkArray(summaryRows, 500)) {
          await tx.insert(collectionHolderSummaries).values(batch).onConflictDoUpdate({
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
          await tx.insert(collectionHolders).values(batch).onConflictDoUpdate({
            target: [collectionHolders.collectionId, collectionHolders.address],
            set: {
              tokenCount: sql`excluded.token_count`,
              lastSeenAt: sql`excluded.last_seen_at`,
            },
          });
        }
      }

      for (const batch of chunkArray(exitedAddresses, 500)) {
        await tx
          .delete(collectionHolders)
          .where(and(eq(collectionHolders.collectionId, collection.id), inArray(collectionHolders.address, batch)));
      }

      await tx
        .update(collections)
        .set({
          holderHistoryLastCheckedBlock: maxBlockNumber,
          holderHistoryLastScannedAt: new Date(),
          holderCount: Array.from(summaryState.values()).filter((v) => v.currentBalance > 0).length,
          holderHistoryStatus: 'success',
          holderHistoryError: null,
          holderHistoryFailures: 0,
        })
        .where(eq(collections.id, collection.id));
    });

    // Derive per-wallet PnL from the freshly-written full transfer ledger.
    // Best-effort: a PnL failure must not fail an otherwise-successful scan.
    // An incremental EVM scan that found nothing new leaves PnL as it was (the nightly Premium runs).
    const nothingNew = collection.chain !== 'solana' && collection.holderHistoryLastCheckedBlock != null && job.processedTransfers === 0;
    try {
      if (!nothingNew) await this.recomputeAndPersistWalletPnl(collection);
    } catch (err) {
      this.logger.error(
        `[PnL] Failed to compute wallet PnL for ${collection.id}: ${(err as Error).stack || (err as Error).message}`,
      );
    }

    job.status = 'completed';
    job.finishedAt = new Date().toISOString();
    this.jobs.set(collection.id, { ...job });
    this.logger.log(`Holder history scan completed for ${collection.id}. Transfers: ${job.processedTransfers}, wallets: ${job.touchedWallets}`);
  }

  /**
   * Sale prices for one page of transfers, keyed by `${txHash}:${saleKey}` in
   * the chain's native coin. Alchemy's getNFTSales is gone, so prices are read
   * from each sale transaction (see evm-sale-prices.ts): its receipt (Seaport
   * order events and payment transfers) and, for non-Seaport sales, the ETH
   * sent with it and the ETH contracts paid out in it (internal transfers, as
   * the Money tab reads them). Failures are logged and leave transfers
   * unpriced; they never fail the scan.
   */
  private async fetchEvmSalePricesForTransfers(
    collection: typeof collections.$inferSelect,
    endpoint: string,
    transfers: AlchemyTransfer[],
    stats: SalePriceStats,
  ): Promise<Map<string, SalePrice>> {
    const prices = new Map<string, SalePrice>();
    const chain = collection.chain;
    if (!supportsSalePrices(chain)) return prices;

    // Only transfers between two wallets can be sales (not mints or burns).
    const byTx = new Map<string, SaleMovement[]>();
    for (const t of transfers) {
      const from = (t.from || '').toLowerCase();
      const to = (t.to || '').toLowerCase();
      if (!from || !to || from === ZERO_ADDRESS || to === ZERO_ADDRESS) continue;
      const hash = t.hash.toLowerCase();
      const list = byTx.get(hash) ?? [];
      list.push({ tokenId: normalizeTokenId(t.erc721TokenId), from, to });
      byTx.set(hash, list);
    }
    if (byTx.size === 0) return prices;
    const hashes = Array.from(byTx.keys());
    stats.transactions += hashes.length;

    let receipts = new Map<string, SaleReceipt>();
    let txs = new Map<string, { value?: string }>();
    const internal = new Map<string, Array<{ hash?: string; rawContract?: { value?: string | null } }>>();
    try {
      receipts = await this.evmRpcMany<SaleReceipt>(endpoint, 'eth_getTransactionReceipt', hashes, (h) => [h]);
      stats.receiptsMissing += hashes.length - receipts.size;

      // What the fallback needs beyond the receipt, fetched only for
      // non-Seaport transactions.
      const fallbackHashes = hashes.filter((h) => receipts.has(h) && needsFallbackContext(chain, receipts.get(h)!));
      const valueHashes = needsTxValue(chain)
        ? fallbackHashes.filter((h) => {
            const sender = (receipts.get(h)!.from || '').toLowerCase();
            return byTx.get(h)!.some((m) => m.to === sender);
          })
        : [];
      if (valueHashes.length) {
        txs = await this.evmRpcMany<{ value?: string }>(endpoint, 'eth_getTransactionByHash', valueHashes, (h) => [h]);
      }

      if (stats.useInternalTransfers) {
        // One query per (block, wallet) for the buyer and seller of each sale.
        const keys = new Set<string>();
        for (const h of fallbackHashes) {
          const block = receipts.get(h)!.blockNumber;
          if (!block) continue;
          for (const m of byTx.get(h)!) {
            keys.add(`${block}|${m.from}`);
            keys.add(`${block}|${m.to}`);
          }
        }
        if (keys.size) {
          const results = await this.evmRpcMany<{ transfers?: Array<{ hash?: string; rawContract?: { value?: string | null } }>; pageKey?: string }>(
            endpoint,
            'alchemy_getAssetTransfers',
            Array.from(keys),
            (key) => {
              const [block, address] = key.split('|');
              return [{ fromBlock: block, toBlock: block, toAddress: address, category: ['internal'], excludeZeroValue: true, maxCount: '0x64' }];
            },
            // ~150 CU a call; sent one at a time (as the Money tab does), ~2 a second.
            1,
            500,
          );
          // A truncated result (more internal transfers in the block than one page) stays unknown.
          for (const [key, r] of results) if (!r.pageKey) internal.set(key, r.transfers ?? []);
        }
      }
      if (needsTxValue(chain)) {
        // Where a seller's plain-ETH payout is invisible (no internal-transfer
        // lookup, or it failed), the fallback only accepts sellers that are
        // ordinary wallets. eth_getCode is cheap and cached per scan.
        const sellers = new Set<string>();
        for (const h of fallbackHashes) for (const m of byTx.get(h)!) sellers.add(m.from);
        const unknown = Array.from(sellers).filter((a) => !stats.codeCache.has(a));
        if (unknown.length) {
          const code = await this.evmRpcMany<string>(endpoint, 'eth_getCode', unknown, (a) => [a, 'latest']);
          for (const [a, c] of code) stats.codeCache.set(a, isContractCode(c));
        }
      }
    } catch (err) {
      stats.errors += 1;
      this.logger.error(`[EVM] sale price lookup failed for ${collection.id}: ${(err as Error).stack || (err as Error).message}`);
    }

    for (const [hash, movements] of byTx) {
      const receipt = receipts.get(hash);
      if (!receipt) continue;
      try {
        const valueHex = txs.get(hash)?.value;
        let internalIn: Map<string, bigint> | null = null;
        if (stats.useInternalTransfers && receipt.blockNumber) {
          internalIn = new Map();
          for (const address of new Set(movements.flatMap((m) => [m.from, m.to]))) {
            const rows = internal.get(`${receipt.blockNumber}|${address}`);
            if (!rows) {
              internalIn = null; // lookup failed: don't treat "no rows" as "paid nothing"
              break;
            }
            const sum = rows
              .filter((r) => (r.hash || '').toLowerCase() === hash)
              .reduce((acc, r) => acc + (r.rawContract?.value ? BigInt(r.rawContract.value) : 0n), 0n);
            internalIn.set(address, sum);
          }
        }
        const derived = deriveSalePrices(chain, collection.contractAddress, receipt, movements, {
          txValue: valueHex ? BigInt(valueHex) : null,
          internalIn,
          isContract: (a) => stats.codeCache.get(a),
        });
        for (const [key, price] of derived) prices.set(`${hash}:${key}`, price);
      } catch (err) {
        stats.errors += 1;
        this.logger.warn(`[EVM] couldn't price tx ${hash} for ${collection.id}: ${(err as Error).message}`);
      }
    }
    stats.pricedTokens += prices.size;
    return prices;
  }

  /**
   * Recompute per-wallet PnL for a collection from its full transfer ledger and
   * persist a fresh snapshot into `collection_holder_pnl`. Runs at scan
   * completion so it always reflects the entire history, independent of whether
   * this scan was a full rebuild or an incremental top-up.
   */
  private async recomputeAndPersistWalletPnl(collection: typeof collections.$inferSelect) {
    const token = nativeTokenForChain(collection.chain);

    const rows = await this.db.query.collectionHolderBalanceHistory.findMany({
      where: eq(collectionHolderBalanceHistory.collectionId, collection.id),
      orderBy: [asc(collectionHolderBalanceHistory.blockNumber), asc(collectionHolderBalanceHistory.logIndex)],
    });

    if (rows.length === 0) {
      await this.db.delete(collectionHolderPnl).where(eq(collectionHolderPnl.collectionId, collection.id));
      return;
    }

    // The ledger stores each transfer twice (an 'out' row for the sender and an
    // 'in' row for the receiver). Collapse them back into one movement per
    // (txHash, tokenId, from, to); an empty/zero counterparty means mint/burn.
    const movements = new Map<string, PnlTransfer & { blockNumber: number }>();
    let minTime = rows[0].blockTimestamp;
    let maxTime = rows[0].blockTimestamp;
    for (const r of rows) {
      if (r.blockTimestamp < minTime) minTime = r.blockTimestamp;
      if (r.blockTimestamp > maxTime) maxTime = r.blockTimestamp;
      const counter = normalizeCounterparty(r.counterpartyAddress);
      const from = r.direction === 'in' ? counter : r.address;
      const to = r.direction === 'in' ? r.address : counter;
      const key = `${r.transactionHash}:${r.tokenId}:${from}:${to}`;
      // The 'in' row carries the buyer's cost basis; the 'out' row carries the
      // seller's net proceeds. These can differ (EVM deducts marketplace fees
      // from the seller's leg), so keep them on separate fields.
      const existing = movements.get(key);
      if (!existing) {
        movements.set(key, {
          tokenId: r.tokenId,
          from,
          to,
          buyerCostNative: r.direction === 'in' ? r.priceNative ?? null : null,
          sellerProceedsNative: r.direction === 'out' ? r.priceNative ?? null : null,
          timestamp: r.blockTimestamp,
          blockNumber: r.blockNumber,
        });
      } else {
        if (r.direction === 'in' && existing.buyerCostNative == null && r.priceNative != null) {
          existing.buyerCostNative = r.priceNative;
        }
        if (r.direction === 'out' && existing.sellerProceedsNative == null && r.priceNative != null) {
          existing.sellerProceedsNative = r.priceNative;
        }
      }
    }

    const ordered = Array.from(movements.values()).sort(
      (a, b) => a.blockNumber - b.blockNumber || a.timestamp.getTime() - b.timestamp.getTime(),
    );

    const dailyUsd = await this.priceOracle.getDailyUsdRates(token, minTime, maxTime);
    const spotUsd = await this.priceOracle.getSpotUsd(token);

    const accumulator = new PnlAccumulator(dailyUsd);
    for (const m of ordered) {
      accumulator.recordTransfer({
        tokenId: m.tokenId,
        from: m.from,
        to: m.to,
        buyerCostNative: m.buyerCostNative,
        sellerProceedsNative: m.sellerProceedsNative,
        timestamp: m.timestamp,
      });
    }
    const results = accumulator.finalize({
      floorPriceNative: collection.floorPrice ?? null,
      spotUsdRate: spotUsd,
    });

    await this.db.delete(collectionHolderPnl).where(eq(collectionHolderPnl.collectionId, collection.id));
    const pnlRows: Array<typeof collectionHolderPnl.$inferInsert> = results
      .filter((r) => r.address)
      .map((r) => ({
        collectionId: collection.id,
        chain: collection.chain,
        address: r.address,
        nativeSymbol: token.symbol,
        buyCount: r.buyCount,
        sellCount: r.sellCount,
        realizedPnlNative: r.realizedPnlNative,
        realizedPnlUsd: r.realizedPnlUsd,
        unrealizedPnlNative: r.unrealizedPnlNative,
        unrealizedPnlUsd: r.unrealizedPnlUsd,
        totalBoughtNative: r.totalBoughtNative,
        totalSoldNative: r.totalSoldNative,
        costBasisRemainingNative: r.costBasisRemainingNative,
        avgHoldTimeSeconds: r.avgHoldTimeSeconds,
      }));
    if (pnlRows.length > 0) {
      for (const batch of chunkArray(pnlRows, 500)) {
        await this.db.insert(collectionHolderPnl).values(batch).onConflictDoNothing();
      }
    }
    // Coverage diagnostics: if these are all zero, prices never reached the ledger.
    const pricedLedgerRows = rows.filter((r) => r.priceNative != null).length;
    const pricedMovements = ordered.filter(
      (m) => m.buyerCostNative != null || m.sellerProceedsNative != null,
    ).length;
    const walletsWithTrades = pnlRows.filter((r) => (r.buyCount ?? 0) > 0 || (r.sellCount ?? 0) > 0).length;
    this.logger.log(
      `[PnL] ${collection.id} (${token.symbol}): ${pnlRows.length} wallets, ` +
        `${pricedLedgerRows}/${rows.length} priced ledger rows, ${pricedMovements}/${ordered.length} priced movements, ` +
        `${walletsWithTrades} wallets with buys/sells`,
    );
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
    return alchemyNetwork(chain);
  }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function toHexBlock(block: number): string {
  return `0x${block.toString(16)}`;
}

function parseBlockTimestamp(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeTokenId(tokenId?: string): string {
  if (!tokenId) return '0';
  if (tokenId.startsWith('0x')) {
    return BigInt(tokenId).toString();
  }
  return tokenId;
}

/** Treat a null / zero-address counterparty as a mint/burn (empty wallet). */
function normalizeCounterparty(addr: string | null): string {
  if (!addr) return '';
  return addr.toLowerCase() === ZERO_ADDRESS ? '' : addr;
}

/**
 * True when eth_getCode returned contract code. An EIP-7702 delegation
 * (0xef0100 + address) is still an ordinary wallet.
 */
function isContractCode(code: string | null | undefined): boolean {
  if (!code || code === '0x' || code === '0x0') return false;
  return !/^0xef0100[0-9a-f]{40}$/i.test(code);
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
