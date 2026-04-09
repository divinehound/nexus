import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  type Database,
  collections,
  collectionHolderBalanceHistory,
  collectionHolderSummaries,
  collectionHolders,
  solanaIndexedMints,
  solanaRawSignatures,
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
      seller?: string;
      buyer?: string;
      nfts?: Array<{
        mint?: string;
      }>;
    };
  };
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
      mode: collection.chain === 'solana' ? 'solana_hybrid' : 'alchemy_backfill',
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

    const solanaRpcUrl = this.getSolanaRpcUrl();
    if (!solanaRpcUrl) {
      throw new Error('SOLANA_RPC_URL or HELIUS_API_KEY required for Solana hybrid indexing');
    }

    // Rebuild summaryState from actual transfer history records, NOT from the
    // summaries table. This ensures idempotent re-runs — DAS fallback won't
    // double-count because we always start from the source of truth.
    const summaryState = new Map<string, MutableSummary>();
    const existingHistory = await this.db.query.collectionHolderBalanceHistory.findMany({
      where: eq(collectionHolderBalanceHistory.collectionId, collection.id),
      orderBy: [asc(collectionHolderBalanceHistory.blockNumber), asc(collectionHolderBalanceHistory.logIndex)],
    });
    const mintsWithHistory = new Set<string>();
    for (const record of existingHistory) {
      mintsWithHistory.add(record.tokenId);
      const summary = ensureSummary(summaryState, record.address);
      if (record.direction === 'in') {
        summary.currentBalance += 1;
        summary.totalReceivedCount += 1;
        const blockNum = record.blockNumber;
        if (!summary.firstReceivedAt || (summary.firstReceivedBlock ?? Number.MAX_SAFE_INTEGER) > blockNum) {
          summary.firstReceivedAt = record.blockTimestamp;
          summary.firstReceivedBlock = blockNum;
        }
        summary.lastReceivedAt = record.blockTimestamp;
        summary.lastReceivedBlock = blockNum;
      } else {
        summary.currentBalance = Math.max(summary.currentBalance - 1, 0);
        summary.totalSentCount += 1;
      }
    }
    this.logger.log(`[Solana Hybrid] Replayed ${existingHistory.length} existing history records, ${mintsWithHistory.size} mints with transfer history`);

    const touched = new Set<string>();
    let maxSlot = collection.holderHistoryLastCheckedBlock ?? 0;

    // Build known signatures from both balance history and raw_signatures for dedup
    const knownHistorySigs = await this.getKnownTransactionHashesForCollection(collection.id);
    const existingRawSigs = await this.db.query.solanaRawSignatures.findMany({
      where: eq(solanaRawSignatures.collectionId, collection.id),
      columns: { signature: true },
    });
    const knownSignatures = new Set([...knownHistorySigs, ...existingRawSigs.map((s) => s.signature)]);

    job.touchedWallets = 0;
    job.processedTransfers = 0;
    this.jobs.set(collection.id, { ...job });

    // --- Phase 1: Mint Discovery (persisted to DB for resume) ---
    let dbMints = await this.db.query.solanaIndexedMints.findMany({
      where: eq(solanaIndexedMints.collectionId, collection.id),
    });

    let mints: SolanaMint[];
    if (dbMints.length > 0) {
      this.logger.log(`[Solana Hybrid] Phase 1: Found ${dbMints.length} previously discovered mints in DB`);
      mints = dbMints.map((m) => ({ mintAddress: m.mintAddress, currentOwner: m.currentOwner || '' }));
    } else {
      this.logger.log(`[Solana Hybrid] Phase 1: Discovering mints for ${collection.contractAddress}`);
      mints = await this.discoverSolanaMints(collection.contractAddress, heliusApiKey);
      this.logger.log(`[Solana Hybrid] Discovered ${mints.length} mints, persisting to DB`);

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
          .onConflictDoNothing();
      }

      dbMints = await this.db.query.solanaIndexedMints.findMany({
        where: eq(solanaIndexedMints.collectionId, collection.id),
      });
    }

    const mintAddressSet = new Set(mints.map((m) => m.mintAddress));

    // --- Phase 2: Signature Collection (persisted to DB for resume) ---
    const pendingMints = dbMints.filter((m) => m.sigCollectionStatus !== 'complete');
    // Track mint times + slots in memory (dbMints snapshot is stale after Phase 2 writes)
    const mintInfoMap = new Map<string, { time: Date | null; slot: number }>();
    for (const m of dbMints) {
      mintInfoMap.set(m.mintAddress, { time: m.firstMintTime, slot: 0 });
    }
    this.logger.log(
      `[Solana Hybrid] Phase 2: Collecting signatures for ${pendingMints.length} pending mints (${dbMints.length - pendingMints.length} already complete)`,
    );

    for (let i = 0; i < pendingMints.length; i++) {
      const mint = pendingMints[i];
      try {
        const { signatures: sigs, oldestBlockTime, oldestSlot } = await this.collectSignaturesForMint(mint.mintAddress, solanaRpcUrl, knownSignatures);

        if (sigs.length > 0) {
          for (const sigBatch of chunkArray(sigs, 500)) {
            await this.db
              .insert(solanaRawSignatures)
              .values(
                sigBatch.map((s) => ({
                  collectionId: collection.id,
                  mintAddress: mint.mintAddress,
                  signature: s,
                })),
              )
              .onConflictDoNothing();
          }
          // Add to known set so subsequent mints don't re-collect shared signatures
          for (const s of sigs) knownSignatures.add(s);
        }

        // Update in-memory mint info map (dbMints snapshot is stale)
        mintInfoMap.set(mint.mintAddress, {
          time: oldestBlockTime ? new Date(oldestBlockTime * 1000) : null,
          slot: oldestSlot ?? 0,
        });

        await this.db
          .update(solanaIndexedMints)
          .set({
            sigCollectionStatus: 'complete',
            sigCount: sigs.length,
            firstMintTime: oldestBlockTime ? new Date(oldestBlockTime * 1000) : null,
          })
          .where(
            and(eq(solanaIndexedMints.collectionId, collection.id), eq(solanaIndexedMints.mintAddress, mint.mintAddress)),
          );
      } catch (err: any) {
        this.logger.warn(`[Solana Hybrid] Failed to collect signatures for mint ${mint.mintAddress}: ${err?.message || err}`);
        await this.db
          .update(solanaIndexedMints)
          .set({ sigCollectionStatus: 'failed' })
          .where(
            and(eq(solanaIndexedMints.collectionId, collection.id), eq(solanaIndexedMints.mintAddress, mint.mintAddress)),
          );
      }

      await sleep(500);

      if ((i + 1) % 100 === 0 || i === pendingMints.length - 1) {
        this.logger.log(`[Solana Hybrid] Signature collection progress: ${i + 1}/${pendingMints.length} pending mints`);
      }
    }

    // --- Phase 3 & 4: Batch Parse + Transfer Extraction (from DB signatures) ---
    this.logger.log(`[Solana Hybrid] Phase 3: Parsing unparsed signatures via Helius batch endpoint`);
    const historyRows: Array<typeof collectionHolderBalanceHistory.$inferInsert> = [];
    const mintsWithTransfers = new Set<string>();
    const perWalletLogIndex = new Map<string, number>();
    let totalParsed = 0;
    let batchNum = 0;

    // Diagnostic counters
    let diagTokenTransferTxs = 0;
    let diagNftEventTxs = 0;
    let diagAccountDataTxs = 0;
    let diagSampleAccountData: string | null = null;
    const diagSeenMints = new Set<string>();

    while (true) {
      const unparsedBatch = await this.db.query.solanaRawSignatures.findMany({
        where: and(eq(solanaRawSignatures.collectionId, collection.id), eq(solanaRawSignatures.parsed, false)),
        limit: 100,
      });

      if (unparsedBatch.length === 0) break;
      batchNum++;

      const signatures = unparsedBatch.map((s) => s.signature);
      const parsed = await this.heliusBatchParseWithRetry(signatures, heliusApiKey, 0);
      totalParsed += parsed.length;

      // Sort by timestamp for chronological processing
      parsed.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

      // Diagnostics: collect info about parsed structure
      for (const tx of parsed) {
        if ((tx.tokenTransfers?.length ?? 0) > 0) diagTokenTransferTxs++;
        if ((tx.events?.nft?.nfts?.length ?? 0) > 0) diagNftEventTxs++;
        let hasAccountDataMint = false;
        for (const t of tx.tokenTransfers ?? []) {
          if (t.mint) diagSeenMints.add(t.mint);
          if (t.tokenAddress) diagSeenMints.add(t.tokenAddress);
        }
        for (const n of tx.events?.nft?.nfts ?? []) {
          if (n.mint) diagSeenMints.add(n.mint);
        }
        for (const a of tx.accountData ?? []) {
          for (const c of a.tokenBalanceChanges ?? []) {
            if (c.mint) {
              diagSeenMints.add(c.mint);
              if (mintAddressSet.has(c.mint)) hasAccountDataMint = true;
            }
          }
        }
        if (hasAccountDataMint) diagAccountDataTxs++;
        // Capture a sample accountData entry for debugging
        if (!diagSampleAccountData && (tx.accountData?.length ?? 0) > 0) {
          const hasAnyTokenChanges = tx.accountData!.some((a) => (a.tokenBalanceChanges?.length ?? 0) > 0);
          const sampleEntry = tx.accountData![0];
          const keys = Object.keys(sampleEntry);
          diagSampleAccountData = `keys=[${keys.join(',')}], entries=${tx.accountData!.length}, anyTokenBalanceChanges=${hasAnyTokenChanges}`;
          if (hasAnyTokenChanges) {
            const entryWithChanges = tx.accountData!.find((a) => (a.tokenBalanceChanges?.length ?? 0) > 0);
            diagSampleAccountData += `, sampleChange=${JSON.stringify(entryWithChanges?.tokenBalanceChanges?.[0])}`;
          }
        }
      }

      // Extract transfers
      for (const tx of parsed) {
        const transfers = extractSolanaTransfersFromBatch(tx, mintAddressSet);
        const timestamp = new Date((tx.timestamp ?? Math.floor(Date.now() / 1000)) * 1000);
        const txSignature = tx.signature || '';
        const slot = tx.slot ?? 0;

        if (slot > maxSlot) maxSlot = slot;

        for (const transfer of transfers) {
          mintsWithTransfers.add(transfer.mintAddress);
          const from = transfer.from; // Solana addresses are case-sensitive (Base58)
          const to = transfer.to;
          const blockNum = slot || maxSlot;

          if (from) {
            const summary = ensureSummary(summaryState, from);
            summary.currentBalance = Math.max(summary.currentBalance - 1, 0);
            summary.totalSentCount += 1;
            touched.add(from);
            const logKey = `${txSignature}:${from}`;
            const logIndex = (perWalletLogIndex.get(logKey) ?? 0) + 1;
            perWalletLogIndex.set(logKey, logIndex);
            historyRows.push({
              collectionId: collection.id,
              chain: collection.chain,
              address: from,
              blockNumber: blockNum,
              blockTimestamp: timestamp,
              transactionHash: txSignature,
              logIndex,
              tokenId: transfer.mintAddress,
              direction: 'out',
              balanceAfter: summary.currentBalance,
              counterpartyAddress: to || null,
            });
          }

          if (to) {
            const summary = ensureSummary(summaryState, to);
            summary.currentBalance += 1;
            summary.totalReceivedCount += 1;
            if (!summary.firstReceivedAt || (summary.firstReceivedBlock ?? Number.MAX_SAFE_INTEGER) > blockNum) {
              summary.firstReceivedAt = timestamp;
              summary.firstReceivedBlock = blockNum;
            }
            summary.lastReceivedAt = timestamp;
            summary.lastReceivedBlock = blockNum;
            touched.add(to);
            const logKey = `${txSignature}:${to}`;
            const logIndex = (perWalletLogIndex.get(logKey) ?? 0) + 1;
            perWalletLogIndex.set(logKey, logIndex);
            historyRows.push({
              collectionId: collection.id,
              chain: collection.chain,
              address: to,
              blockNumber: blockNum,
              blockTimestamp: timestamp,
              transactionHash: txSignature,
              logIndex,
              tokenId: transfer.mintAddress,
              direction: 'in',
              balanceAfter: summary.currentBalance,
              counterpartyAddress: from || null,
            });
          }
        }
      }

      // Mark batch as parsed in DB
      await this.db
        .update(solanaRawSignatures)
        .set({ parsed: true })
        .where(inArray(solanaRawSignatures.id, unparsedBatch.map((s) => s.id)));

      // Persist history rows periodically to avoid huge memory buildup
      if (historyRows.length >= 1000) {
        await this.persistHistoryBatch(historyRows);
        historyRows.length = 0;
      }

      await sleep(500); // Rate limit Helius

      if (batchNum % 10 === 0) {
        this.logger.log(`[Solana Hybrid] Parse progress: ${totalParsed} txs parsed, ${mintsWithTransfers.size} mints with transfers`);
      }
    }

    // Persist remaining history rows
    await this.persistHistoryBatch(historyRows);

    // Log diagnostics
    const matchingMints = [...diagSeenMints].filter((m) => mintAddressSet.has(m));
    if (diagSampleAccountData) {
      this.logger.log(`[Solana Hybrid] AccountData sample: ${diagSampleAccountData}`);
    }
    this.logger.log(
      `[Solana Hybrid] Diagnostics: ${diagTokenTransferTxs} txs had tokenTransfers, ${diagNftEventTxs} had events.nft.nfts, ${diagAccountDataTxs} had accountData with matching mints`,
    );
    this.logger.log(
      `[Solana Hybrid] Unique mints in parsed data: ${diagSeenMints.size}, matching our set: ${matchingMints.length}`,
    );
    if (diagSeenMints.size > 0 && matchingMints.length === 0) {
      this.logger.log(`[Solana Hybrid] Sample seen mints: [${[...diagSeenMints].slice(0, 5).join(', ')}]`);
      this.logger.log(`[Solana Hybrid] Sample expected mints: [${[...mintAddressSet].slice(0, 5).join(', ')}]`);
    }

    // For mints with no transfer history (this run or previous), use DAS ownership.
    // Skips mints already accounted for via transfer records to prevent double-counting.
    // Sort by mint time so balanceAfter values are chronologically correct.
    const now = new Date();
    const dasHistoryRows: Array<typeof collectionHolderBalanceHistory.$inferInsert> = [];

    const dasFallbackMints = mints
      .filter((m) => !mintsWithTransfers.has(m.mintAddress) && !mintsWithHistory.has(m.mintAddress) && m.currentOwner)
      .sort((a, b) => {
        const aTime = mintInfoMap.get(a.mintAddress)?.time?.getTime() ?? 0;
        const bTime = mintInfoMap.get(b.mintAddress)?.time?.getTime() ?? 0;
        return aTime - bTime;
      });

    for (const mint of dasFallbackMints) {
      const ownerKey = mint.currentOwner; // Solana addresses are case-sensitive (Base58)
        const summary = ensureSummary(summaryState, ownerKey);
        summary.currentBalance += 1;
        summary.totalReceivedCount += 1;
        const mintInfo = mintInfoMap.get(mint.mintAddress);
        const mintTime = mintInfo?.time ?? now;
        const mintSlot = mintInfo?.slot ?? 0;
        if (!summary.firstReceivedAt || mintTime < summary.firstReceivedAt) {
          summary.firstReceivedAt = mintTime;
          summary.firstReceivedBlock = mintSlot;
        }
        if (!summary.lastReceivedAt || mintTime > summary.lastReceivedAt) {
          summary.lastReceivedAt = mintTime;
          summary.lastReceivedBlock = mintSlot;
        }
        touched.add(ownerKey);

        // Create a balance history row so the mint shows in "Balance over time"
        dasHistoryRows.push({
          collectionId: collection.id,
          chain: collection.chain,
          address: ownerKey,
          blockNumber: mintSlot,
          blockTimestamp: mintTime,
          transactionHash: `das-mint:${mint.mintAddress}`,
          logIndex: 1,
          tokenId: mint.mintAddress,
          direction: 'in',
          balanceAfter: summary.currentBalance,
          counterpartyAddress: null,
        });
    }

    if (dasHistoryRows.length > 0) {
      this.logger.log(`[Solana Hybrid] Persisting ${dasHistoryRows.length} DAS mint history rows`);
      await this.persistHistoryBatch(dasHistoryRows);
    }

    job.processedTransfers = historyRows.length + dasHistoryRows.length;
    job.touchedWallets = touched.size;
    job.toBlock = maxSlot;
    this.jobs.set(collection.id, { ...job });

    this.logger.log(
      `[Solana Hybrid] Extracted ${mintsWithTransfers.size} mints with transfers, ${touched.size} wallets, max slot ${maxSlot}`,
    );

    await this.persistFinalHolderState(collection, summaryState, touched, maxSlot, job);
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

    if (response.status === 429) {
      if (attempt >= 5) {
        throw new Error(`RPC ${method} rate limited after ${attempt} retries`);
      }
      const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
      this.logger.warn(`RPC rate limited for ${method}, retrying in ${delay}ms (attempt ${attempt + 1})`);
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

  private async batchParseSignatures(
    signatures: string[],
    heliusApiKey: string,
    job: InMemoryScanJob,
    collectionId: string,
  ): Promise<HeliusTransaction[]> {
    const allParsed: HeliusTransaction[] = [];
    const batches = chunkArray(signatures, 100);

    for (let i = 0; i < batches.length; i++) {
      if (i > 0) await sleep(500); // Respect 2 req/s Helius Enhanced API rate limit

      const parsed = await this.heliusBatchParseWithRetry(batches[i], heliusApiKey, 0);
      allParsed.push(...parsed);

      job.processedTransfers = allParsed.length;
      this.jobs.set(collectionId, { ...job });

      if ((i + 1) % 10 === 0 || i === batches.length - 1) {
        this.logger.log(`[Solana Hybrid] Parsed batch ${i + 1}/${batches.length} (${allParsed.length} total transactions)`);
      }
    }

    return allParsed;
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

function extractSolanaTransfersFromBatch(
  tx: HeliusTransaction,
  mintAddresses: Set<string>,
): Array<{ mintAddress: string; from: string; to: string }> {
  const matches = new Map<string, { mintAddress: string; from: string; to: string }>();

  for (const transfer of tx.tokenTransfers ?? []) {
    const mint = transfer.mint || transfer.tokenAddress || '';
    if (!mintAddresses.has(mint)) continue;

    const from = transfer.fromUserAccount || transfer.fromTokenAccount || '';
    const to = transfer.toUserAccount || transfer.toTokenAccount || '';
    if (!from && !to) continue;

    matches.set(`${mint}:${from}:${to}`, { mintAddress: mint, from, to });
  }

  // NFT events: seller/buyer are on the parent events.nft object, not on each nft item
  const nftEvent = tx.events?.nft;
  if (nftEvent?.nfts?.length) {
    const from = nftEvent.seller || '';
    const to = nftEvent.buyer || '';
    if (from || to) {
      for (const nft of nftEvent.nfts) {
        const mint = nft.mint || '';
        if (!mintAddresses.has(mint)) continue;
        const key = `${mint}:${from}:${to}`;
        if (!matches.has(key)) {
          matches.set(key, { mintAddress: mint, from, to });
        }
      }
    }
  }

  // accountData: parse tokenBalanceChanges to catch transfers missed by the above.
  // Group by mint — negative amount = sender, positive amount = receiver.
  const balanceChanges = new Map<string, { from: string; to: string }>();
  for (const account of tx.accountData ?? []) {
    for (const change of account.tokenBalanceChanges ?? []) {
      const mint = change.mint || '';
      if (!mintAddresses.has(mint)) continue;
      if (!change.userAccount) continue;

      const amount = parseFloat(change.rawTokenAmount?.tokenAmount || '0');
      if (amount === 0) continue;

      const existing = balanceChanges.get(mint) || { from: '', to: '' };
      if (amount > 0) {
        existing.to = change.userAccount;
      } else {
        existing.from = change.userAccount;
      }
      balanceChanges.set(mint, existing);
    }
  }
  for (const [mint, transfer] of balanceChanges) {
    if (!transfer.from && !transfer.to) continue;
    const key = `${mint}:${transfer.from}:${transfer.to}`;
    if (!matches.has(key)) {
      matches.set(key, { mintAddress: mint, from: transfer.from, to: transfer.to });
    }
  }

  return Array.from(matches.values());
}
