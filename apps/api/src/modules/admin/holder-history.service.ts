import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  type Database,
  collections,
  collectionHolderBalanceHistory,
  collectionHolderSummaries,
  collectionHolders,
  solanaIndexedMints,
  solanaRawSignatures,
  solanaParsedTransfers,
} from '@nexus/database';
import { runAllParsers } from './solana-parsers';

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
