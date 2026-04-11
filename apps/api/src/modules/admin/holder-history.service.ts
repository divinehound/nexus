import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm';
import bs58 from 'bs58';
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

    // Full reset: delete all history for this collection and reset parsed flags.
    // We rebuild everything from scratch each scan so we can process transfers
    // in strict global chronological order (required for correct balanceAfter).
    await this.db
      .delete(collectionHolderBalanceHistory)
      .where(eq(collectionHolderBalanceHistory.collectionId, collection.id));
    await this.db
      .update(solanaRawSignatures)
      .set({ parsed: false })
      .where(eq(solanaRawSignatures.collectionId, collection.id));
    this.logger.log(`[Solana Hybrid] Reset: cleared history and parsed flags for rebuild`);

    // Start with an empty summaryState — we just deleted all history and will
    // rebuild chronologically from scratch via the collect-sort-process pattern.
    const summaryState = new Map<string, MutableSummary>();
    const mintsWithHistory = new Set<string>();

    const touched = new Set<string>();
    let maxSlot = collection.holderHistoryLastCheckedBlock ?? 0;

    // Accumulates all transfers extracted from Phase 3 and Phase 3b. We sort
    // and process these chronologically AFTER extraction so balanceAfter values
    // form a correct running balance regardless of extraction order.
    type CollectedTransfer = {
      mintAddress: string;
      from: string;
      to: string;
      signature: string;
      timestamp: Date;
      slot: number;
    };
    const collectedTransfers: CollectedTransfer[] = [];


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

    // --- Phase 3: Batch Parse (collect transfers only — no state updates yet) ---
    this.logger.log(`[Solana Hybrid] Phase 3: Parsing signatures via Helius batch endpoint`);
    const mintsWithTransfers = new Set<string>();
    let totalParsed = 0;
    let batchNum = 0;

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

      // Extract transfers and accumulate — DO NOT update summaryState or create
      // history rows yet. We process everything in chronological order after
      // Phase 3b completes.
      for (const tx of parsed) {
        const transfers = extractSolanaTransfersFromBatch(tx, mintAddressSet);
        if (transfers.length === 0) continue;
        const timestamp = new Date((tx.timestamp ?? Math.floor(Date.now() / 1000)) * 1000);
        const txSignature = tx.signature || '';
        const slot = tx.slot ?? 0;
        for (const transfer of transfers) {
          mintsWithTransfers.add(transfer.mintAddress);
          collectedTransfers.push({
            mintAddress: transfer.mintAddress,
            from: transfer.from,
            to: transfer.to,
            signature: txSignature,
            timestamp,
            slot,
          });
        }
      }

      // Mark batch as parsed in DB
      await this.db
        .update(solanaRawSignatures)
        .set({ parsed: true })
        .where(inArray(solanaRawSignatures.id, unparsedBatch.map((s) => s.id)));

      await sleep(500); // Rate limit Helius

      if (batchNum % 10 === 0) {
        this.logger.log(
          `[Solana Hybrid] Phase 3 progress: ${totalParsed} txs parsed, ${collectedTransfers.length} transfers collected, ${mintsWithTransfers.size} mints`,
        );
      }
    }

    this.logger.log(
      `[Solana Hybrid] Phase 3 complete: ${totalParsed} txs parsed, ${collectedTransfers.length} transfers collected, ${mintsWithTransfers.size} mints with transfers`,
    );

    // --- Phase 3b: Raw getTransaction fallback for mints without detected transfers ---
    // The Helius batch parse misses most NFT transfers (tokenBalanceChanges is empty).
    // Fall back to standard getTransaction RPC which has pre/postTokenBalances.
    const mintsNeedingFallback = [...mintAddressSet].filter(
      (m) => !mintsWithTransfers.has(m) && !mintsWithHistory.has(m),
    );

    if (mintsNeedingFallback.length > 0) {
      // Per-asset fallback using Helius Enhanced Transactions endpoint.
      // Collects transfers into the same collectedTransfers array as Phase 3.
      this.logger.log(
        `[Solana Hybrid] Phase 3b: Per-asset tx fetch for ${mintsNeedingFallback.length} mints`,
      );

      let fallbackTransferCount = 0;
      let consecutiveFailures = 0;
      let diag3bMintsProcessed = 0;
      let diag3bMintsWithTxs = 0;
      let diag3bMintsWithTransfers = 0;

      for (let mi = 0; mi < mintsNeedingFallback.length; mi++) {
        if (mi > 0) await sleep(600);

        if ((mi + 1) % 25 === 0 || mi === mintsNeedingFallback.length - 1) {
          this.logger.log(
            `[Solana Hybrid] Phase 3b progress: ${mi + 1}/${mintsNeedingFallback.length} mints | withTxs=${diag3bMintsWithTxs}, withTransfers=${diag3bMintsWithTransfers}, totalCollected=${fallbackTransferCount}`,
          );
        }

        const mintAddress = mintsNeedingFallback[mi];
        let assetTxs: HeliusTransaction[] = [];
        try {
          assetTxs = await this.fetchAssetTransactionsWithRetry(mintAddress, heliusApiKey, 0);
        } catch (err: any) {
          consecutiveFailures++;
          if (consecutiveFailures >= 10) {
            this.logger.warn(
              `[Solana Hybrid] Phase 3b aborted: 10 consecutive failures. Last error: ${err?.message}`,
            );
            break;
          }
          continue;
        }
        consecutiveFailures = 0;
        diag3bMintsProcessed++;

        if (assetTxs.length === 0) continue;
        diag3bMintsWithTxs++;

        let hadTransfer = false;
        for (const tx of assetTxs) {
          const transfers = extractSolanaTransfersFromBatch(tx, mintAddressSet);
          if (transfers.length === 0) continue;
          hadTransfer = true;

          const txTimestamp = new Date((tx.timestamp ?? Math.floor(Date.now() / 1000)) * 1000);
          const txSignature = tx.signature || '';
          const txSlot = tx.slot ?? 0;

          for (const transfer of transfers) {
            mintsWithTransfers.add(transfer.mintAddress);
            collectedTransfers.push({
              mintAddress: transfer.mintAddress,
              from: transfer.from,
              to: transfer.to,
              signature: txSignature,
              timestamp: txTimestamp,
              slot: txSlot,
            });
            fallbackTransferCount++;
          }
        }

        if (hadTransfer) diag3bMintsWithTransfers++;
      }

      this.logger.log(
        `[Solana Hybrid] Phase 3b complete: processed=${diag3bMintsProcessed}, mintsWithTxs=${diag3bMintsWithTxs}, mintsWithTransfers=${diag3bMintsWithTransfers}, collected=${fallbackTransferCount}`,
      );
    }

    // --- Phase 3c: DAS ownership fallback ---
    // For mints with no detected transfers, synthesize a "mint event" from
    // DAS current ownership + mint time. Add to collectedTransfers so they
    // get sorted and processed chronologically alongside real transfers.
    const nowDate = new Date();
    let dasFallbackCount = 0;
    for (const mint of mints) {
      if (mintsWithTransfers.has(mint.mintAddress)) continue;
      if (!mint.currentOwner) continue;
      const mintInfo = mintInfoMap.get(mint.mintAddress);
      const mintTime = mintInfo?.time ?? nowDate;
      const mintSlot = mintInfo?.slot ?? 0;
      collectedTransfers.push({
        mintAddress: mint.mintAddress,
        from: '',
        to: mint.currentOwner,
        signature: `das-mint:${mint.mintAddress}`,
        timestamp: mintTime,
        slot: mintSlot,
      });
      dasFallbackCount++;
    }
    this.logger.log(`[Solana Hybrid] Phase 3c: Added ${dasFallbackCount} DAS ownership events`);

    // --- Phase 4: Sort collected transfers globally and process chronologically ---
    // This is CRITICAL for correct balanceAfter values — if transfers are
    // processed out of order, the running balance won't be monotonic over time.
    collectedTransfers.sort((a, b) => {
      const diff = a.timestamp.getTime() - b.timestamp.getTime();
      if (diff !== 0) return diff;
      return a.slot - b.slot;
    });

    // Dedupe via unique constraint (txHash + logIndex + address); also
    // track per-key logIndex so transfers sharing a signature get unique indices.
    const perWalletLogIndex = new Map<string, number>();
    const historyRows: Array<typeof collectionHolderBalanceHistory.$inferInsert> = [];

    this.logger.log(
      `[Solana Hybrid] Phase 4: Processing ${collectedTransfers.length} collected transfers in chronological order`,
    );

    for (const transfer of collectedTransfers) {
      const { mintAddress, from, to, signature, timestamp, slot } = transfer;
      const blockNum = slot || maxSlot;
      if (slot > maxSlot) maxSlot = slot;

      if (from) {
        const summary = ensureSummary(summaryState, from);
        summary.currentBalance = Math.max(summary.currentBalance - 1, 0);
        summary.totalSentCount += 1;
        touched.add(from);
        const logKey = `${signature}:${from}`;
        const logIndex = (perWalletLogIndex.get(logKey) ?? 0) + 1;
        perWalletLogIndex.set(logKey, logIndex);
        historyRows.push({
          collectionId: collection.id,
          chain: collection.chain,
          address: from,
          blockNumber: blockNum,
          blockTimestamp: timestamp,
          transactionHash: signature,
          logIndex,
          tokenId: mintAddress,
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
        const logKey = `${signature}:${to}`;
        const logIndex = (perWalletLogIndex.get(logKey) ?? 0) + 1;
        perWalletLogIndex.set(logKey, logIndex);
        historyRows.push({
          collectionId: collection.id,
          chain: collection.chain,
          address: to,
          blockNumber: blockNum,
          blockTimestamp: timestamp,
          transactionHash: signature,
          logIndex,
          tokenId: mintAddress,
          direction: 'in',
          balanceAfter: summary.currentBalance,
          counterpartyAddress: from || null,
        });
      }

      if (historyRows.length >= 1000) {
        await this.persistHistoryBatch(historyRows);
        historyRows.length = 0;
      }
    }

    await this.persistHistoryBatch(historyRows);
    historyRows.length = 0;

    job.processedTransfers = collectedTransfers.length;
    job.touchedWallets = touched.size;
    job.toBlock = maxSlot;
    this.jobs.set(collection.id, { ...job });

    this.logger.log(
      `[Solana Hybrid] Complete: ${collectedTransfers.length} events processed, ${touched.size} wallets, max slot ${maxSlot}`,
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

  private async fetchAssetTransactionsWithRetry(
    assetAddress: string,
    apiKey: string,
    attempt: number,
  ): Promise<HeliusTransaction[]> {
    const response = await this.withTimeout(
      fetch(`https://api.helius.xyz/v0/addresses/${assetAddress}/transactions?api-key=${apiKey}&limit=100`),
      30000,
      `helius asset transactions ${assetAddress}`,
    );

    if (response.status === 429 || response.status === 413) {
      if (attempt >= 7) {
        throw new Error(`Helius asset transactions rate limited for ${assetAddress} after ${attempt} retries`);
      }
      const delay = Math.min(2000 * Math.pow(2, attempt), 60000);
      this.logger.warn(
        `Helius asset transactions rate limited (${response.status}) for ${assetAddress}, retrying in ${delay}ms (attempt ${attempt + 1})`,
      );
      await sleep(delay);
      return this.fetchAssetTransactionsWithRetry(assetAddress, apiKey, attempt + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Helius asset transactions failed for ${assetAddress} (${response.status}): ${text}`);
    }

    const data = await response.json();
    return Array.isArray(data) ? (data as HeliusTransaction[]) : [];
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

  // MPL Core assets: parse TransferV1 instructions directly.
  // Metaplex Core assets don't use SPL token accounts — they're stored in the
  // asset account's data and transferred via the MPL Core program's TransferV1
  // instruction. Helius's enhanced parser classifies these as type=UNKNOWN,
  // so we decode the instructions ourselves.
  //
  // TransferV1 account layout:
  //   [0] asset    (the NFT address)
  //   [1] collection (or MPL Core program ID placeholder)
  //   [2] payer    (the current owner, unless authority overrides)
  //   [3] authority (optional — if set, this is the actual owner; else placeholder)
  //   [4] new_owner (the recipient)
  //   [5] system_program (placeholder if unused)
  //   [6] log_wrapper   (placeholder if unused)
  const processMplCoreInstr = (instr: { programId?: string; accounts?: string[]; data?: string }) => {
    if (instr.programId !== MPL_CORE_PROGRAM_ID) return;
    if (!instr.accounts || instr.accounts.length < 5) return;

    // Decode discriminator from instruction data (first byte identifies the instruction)
    let discriminator: number | null = null;
    if (instr.data) {
      try {
        const decoded = bs58.decode(instr.data);
        if (decoded.length > 0) discriminator = decoded[0];
      } catch {
        // ignore bad base58
      }
    }
    if (discriminator !== MPL_CORE_TRANSFER_DISCRIMINATOR) return;

    const asset = instr.accounts[0];
    if (!mintAddresses.has(asset)) return;

    const payer = instr.accounts[2];
    const authority = instr.accounts[3];
    const newOwner = instr.accounts[4];

    // If authority is a real pubkey (not the program ID placeholder), it's the owner
    const from = authority && authority !== MPL_CORE_PROGRAM_ID ? authority : payer;
    const to = newOwner;

    if (!from || !to || from === to) return;

    const key = `${asset}:${from}:${to}`;
    if (!matches.has(key)) {
      matches.set(key, { mintAddress: asset, from, to });
    }
  };

  for (const instr of tx.instructions ?? []) {
    processMplCoreInstr(instr);
    for (const inner of instr.innerInstructions ?? []) {
      processMplCoreInstr(inner);
    }
  }

  return Array.from(matches.values());
}

const MPL_CORE_PROGRAM_ID = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const MPL_CORE_TRANSFER_DISCRIMINATOR = 14;

function extractTransfersFromRawTransaction(
  txData: { slot?: number; blockTime?: number | null; meta?: { preTokenBalances?: any[]; postTokenBalances?: any[] } },
  mintAddresses: Set<string>,
): Array<{ mintAddress: string; from: string; to: string }> {
  const pre = txData.meta?.preTokenBalances ?? [];
  const post = txData.meta?.postTokenBalances ?? [];

  // Track balance changes per (accountIndex, mint) so we can identify actual
  // movements (pre=1→post=0 = sender, pre=0→post=1 = receiver). This avoids
  // false positives from marketplace transactions like Magic Eden Cancel Buy
  // where escrow token accounts are opened/closed without real NFT movement.
  type AccountInfo = { preAmount: number; postAmount: number; owner: string; mint: string };
  const accountStates = new Map<string, AccountInfo>();

  for (const b of pre) {
    if (!b.mint || !mintAddresses.has(b.mint)) continue;
    const key = `${b.accountIndex}:${b.mint}`;
    accountStates.set(key, {
      preAmount: parseInt(b.uiTokenAmount?.amount || '0'),
      postAmount: 0,
      owner: b.owner || '',
      mint: b.mint,
    });
  }

  for (const b of post) {
    if (!b.mint || !mintAddresses.has(b.mint)) continue;
    const key = `${b.accountIndex}:${b.mint}`;
    const existing = accountStates.get(key);
    if (existing) {
      existing.postAmount = parseInt(b.uiTokenAmount?.amount || '0');
      // Prefer post-state owner if present (in case it changed)
      if (b.owner) existing.owner = b.owner;
    } else {
      accountStates.set(key, {
        preAmount: 0,
        postAmount: parseInt(b.uiTokenAmount?.amount || '0'),
        owner: b.owner || '',
        mint: b.mint,
      });
    }
  }

  // Per mint: find senders (pre>0, post=0) and receivers (pre=0, post>0)
  const sendersByMint = new Map<string, string>();
  const receiversByMint = new Map<string, string>();

  for (const info of accountStates.values()) {
    if (info.preAmount > 0 && info.postAmount === 0 && info.owner) {
      sendersByMint.set(info.mint, info.owner);
    } else if (info.preAmount === 0 && info.postAmount > 0 && info.owner) {
      receiversByMint.set(info.mint, info.owner);
    }
  }

  // A valid transfer requires both a sender AND receiver (or just receiver for mint events).
  // Cancel Buy / Cancel Listing etc. wouldn't have matching sender+receiver.
  const transfers: Array<{ mintAddress: string; from: string; to: string }> = [];
  const allMints = new Set([...sendersByMint.keys(), ...receiversByMint.keys()]);

  for (const mint of allMints) {
    const from = sendersByMint.get(mint) || '';
    const to = receiversByMint.get(mint) || '';

    // Skip if same wallet (no real transfer)
    if (from && to && from === to) continue;

    // Skip if neither side is present (shouldn't happen but defensive)
    if (!from && !to) continue;

    // Real transfer: both sender and receiver exist
    if (from && to) {
      transfers.push({ mintAddress: mint, from, to });
      continue;
    }

    // Mint event: receiver only, no sender
    // (Only count as mint if pre has no entries for this mint at all)
    if (!from && to) {
      const hadPreEntry = pre.some((b: any) => b.mint === mint);
      if (!hadPreEntry) {
        transfers.push({ mintAddress: mint, from: '', to });
      }
      // If there was a pre entry but no valid sender, it's likely an escrow
      // account change (e.g., cancel buy) — skip it.
    }

    // Burn event: sender only, no receiver
    // (Only count as burn if post has no entries for this mint at all)
    if (from && !to) {
      const hadPostEntry = post.some((b: any) => b.mint === mint);
      if (!hadPostEntry) {
        transfers.push({ mintAddress: mint, from, to: '' });
      }
    }
  }

  return transfers;
}
