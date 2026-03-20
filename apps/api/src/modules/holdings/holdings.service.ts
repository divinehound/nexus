import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  chainEnum,
  collections,
  projects,
  type Database,
  walletHoldingsSnapshots,
  walletIndexingJobs,
  wallets,
  trackingTierEnum,
} from '@nexus/database';
import { DATABASE_TOKEN } from '../../common/database/database.module';

type Chain = (typeof chainEnum.enumValues)[number];
type TrackingTier = (typeof trackingTierEnum.enumValues)[number];

type Holding = {
  contractAddress: string;
  tokenCount: number;
};

@Injectable()
export class HoldingsService {
  private readonly maxCollectionsPerRun: number;

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly configService: ConfigService,
  ) {
    this.maxCollectionsPerRun = Number(
      this.configService.get('holdings.maxCollectionsPerRun') ?? 50,
    );
  }

  private async createIndexingJob(userId: string, walletId: string, retryOfJobId?: string) {
    const [job] = await this.db
      .insert(walletIndexingJobs)
      .values({
        userId,
        walletId,
        type: 'holdings_refresh',
        retryOfJobId: retryOfJobId ?? null,
        status: 'queued',
      })
      .returning();

    return job;
  }

  async queueWalletIndexing(userId: string, walletId: string) {
    const wallet = await this.db.query.wallets.findFirst({
      where: and(eq(wallets.id, walletId), eq(wallets.userId, userId)),
    });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    const job = await this.createIndexingJob(userId, walletId);

    setTimeout(() => {
      void this.runIndexingJob(job.id).catch(() => {
        // intentionally swallowed for fire-and-forget execution
      });
    }, 0);

    return { queued: true, jobId: job.id };
  }

  async refreshWalletIndexing(walletId: string) {
    const wallet = await this.db.query.wallets.findFirst({ where: eq(wallets.id, walletId) });
    if (!wallet?.userId) {
      throw new NotFoundException('Wallet not found or not linked to a user');
    }

    const job = await this.createIndexingJob(wallet.userId, wallet.id);

    await this.runIndexingJob(job.id);
    return this.db.query.walletIndexingJobs.findFirst({ where: eq(walletIndexingJobs.id, job.id) });
  }

  async retryIndexingJob(jobId: string) {
    const originalJob = await this.db.query.walletIndexingJobs.findFirst({
      where: eq(walletIndexingJobs.id, jobId),
    });

    if (!originalJob) {
      throw new NotFoundException('Indexing job not found');
    }

    const retryJob = await this.createIndexingJob(
      originalJob.userId,
      originalJob.walletId,
      originalJob.id,
    );

    setTimeout(() => {
      void this.runIndexingJob(retryJob.id).catch(() => {
        // intentionally swallowed for fire-and-forget execution
      });
    }, 0);

    return retryJob;
  }

  private scoreHolding(holding: Holding): { score: number; tier: TrackingTier; reason: string } {
    const byteSignal = holding.contractAddress
      .toLowerCase()
      .replace('0x', '')
      .split('')
      .reduce((acc, c) => acc + c.charCodeAt(0), 0) % 30;

    const score = Math.max(0, Math.min(100, holding.tokenCount * 14 + byteSignal));

    if (score >= 65) return { score, tier: 'active', reason: 'high_token_signal' };
    if (score >= 35) return { score, tier: 'lightweight', reason: 'moderate_token_signal' };
    return { score, tier: 'suppressed', reason: 'low_signal_or_spam_like' };
  }

  private async mockWalletHoldings(wallet: { address: string; chain: Chain }): Promise<Holding[]> {
    const seed = wallet.address.toLowerCase().replace('0x', '').padEnd(40, '0');
    const total = 8 + (seed.charCodeAt(0) % 8);

    return Array.from({ length: total }).map((_, idx) => {
      const contractAddress = `0x${(seed.slice(idx, idx + 38) + String(idx).padStart(2, '0')).slice(0, 40)}`;
      const tokenCount = ((seed.charCodeAt((idx * 3) % seed.length) + idx) % 6) + 1;
      return { contractAddress, tokenCount };
    });
  }

  private async ensureCollection(
    chain: Chain,
    contractAddress: string,
    data: { tier: TrackingTier; score: number; reason: string },
  ) {
    const existing = await this.db.query.collections.findFirst({
      where: and(eq(collections.chain, chain), eq(collections.contractAddress, contractAddress)),
    });

    if (existing) {
      const [updated] = await this.db
        .update(collections)
        .set({
          trackingTier: data.tier,
          qualityScore: data.score.toFixed(2),
          qualityReason: data.reason,
          lastSeenAt: new Date(),
        })
        .where(eq(collections.id, existing.id))
        .returning();
      return updated;
    }

    const short = contractAddress.slice(2, 8);
    const baseSlug = `auto-${chain}-${short}`;

    const [project] = await this.db
      .insert(projects)
      .values({
        name: `Auto ${chain.toUpperCase()} ${short}`,
        slug: `${baseSlug}-${Date.now()}`,
        isVerified: false,
      })
      .returning();

    const [created] = await this.db
      .insert(collections)
      .values({
        projectId: project.id,
        contractAddress,
        chain,
        name: `Collection ${short}`,
        collectionType: chain === 'solana' ? 'spl' : 'erc721',
        trackingTier: data.tier,
        qualityScore: data.score.toFixed(2),
        qualityReason: data.reason,
      })
      .returning();

    return created;
  }

  async runIndexingJob(jobId: string) {
    const job = await this.db.query.walletIndexingJobs.findFirst({
      where: eq(walletIndexingJobs.id, jobId),
    });
    if (!job) throw new NotFoundException('Indexing job not found');

    await this.db
      .update(walletIndexingJobs)
      .set({ status: 'running', startedAt: new Date(), error: null })
      .where(eq(walletIndexingJobs.id, jobId));

    try {
      const wallet = await this.db.query.wallets.findFirst({ where: eq(wallets.id, job.walletId) });
      if (!wallet?.userId) throw new BadRequestException('Wallet not linked');

      const holdings = await this.mockWalletHoldings({ address: wallet.address, chain: wallet.chain as Chain });
      const sorted = holdings.sort((a, b) => b.tokenCount - a.tokenCount);
      const inScope = sorted.slice(0, this.maxCollectionsPerRun);
      const overflow = sorted.slice(this.maxCollectionsPerRun);

      const now = new Date();
      for (const holding of sorted) {
        await this.db
          .insert(walletHoldingsSnapshots)
          .values({
            userId: wallet.userId,
            walletId: wallet.id,
            chain: wallet.chain,
            contractAddress: holding.contractAddress,
            tokenCount: holding.tokenCount,
            firstSeenAt: now,
            lastSeenAt: now,
          })
          .onConflictDoUpdate({
            target: [walletHoldingsSnapshots.walletId, walletHoldingsSnapshots.chain, walletHoldingsSnapshots.contractAddress],
            set: {
              userId: wallet.userId,
              tokenCount: holding.tokenCount,
              lastSeenAt: now,
            },
          });
      }

      let active = 0;
      let lightweight = 0;
      let suppressed = 0;

      for (const holding of inScope) {
        const scored = this.scoreHolding(holding);
        await this.ensureCollection(wallet.chain as Chain, holding.contractAddress, scored);
        if (scored.tier === 'active') active++;
        if (scored.tier === 'lightweight') lightweight++;
        if (scored.tier === 'suppressed') suppressed++;
      }

      for (const holding of overflow) {
        const tier: TrackingTier = holding.tokenCount > 1 ? 'lightweight' : 'suppressed';
        await this.ensureCollection(wallet.chain as Chain, holding.contractAddress, {
          score: Math.max(5, holding.tokenCount * 8),
          tier,
          reason: 'overflow_limit_applied',
        });
        if (tier === 'lightweight') lightweight++;
        if (tier === 'suppressed') suppressed++;
      }

      await this.db
        .update(wallets)
        .set({ lastSyncedAt: now })
        .where(eq(wallets.id, wallet.id));

      await this.db
        .update(walletIndexingJobs)
        .set({
          status: 'completed',
          finishedAt: now,
          statsJson: {
            holdingsDiscovered: holdings.length,
            active,
            lightweight,
            suppressed,
            overflow: overflow.length,
            maxCollectionsPerRun: this.maxCollectionsPerRun,
          },
          error: null,
        })
        .where(eq(walletIndexingJobs.id, jobId));
    } catch (error) {
      await this.db
        .update(walletIndexingJobs)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          error: error instanceof Error ? error.message : 'Unknown indexing error',
        })
        .where(eq(walletIndexingJobs.id, jobId));
      throw error;
    }
  }

  async getMyHoldingsSummary(userId: string) {
    const [counts] = await this.db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE c.tracking_tier = 'active')::int AS active,
        COUNT(*) FILTER (WHERE c.tracking_tier = 'lightweight')::int AS lightweight,
        COUNT(*) FILTER (WHERE c.tracking_tier = 'suppressed')::int AS suppressed,
        COUNT(DISTINCT s.wallet_id)::int AS wallet_coverage
      FROM wallet_holdings_snapshots s
      LEFT JOIN collections c
        ON c.chain = s.chain
       AND c.contract_address = s.contract_address
      WHERE s.user_id = ${userId}
    `);

    const [lastJob] = await this.db.query.walletIndexingJobs.findMany({
      where: eq(walletIndexingJobs.userId, userId),
      orderBy: [desc(walletIndexingJobs.startedAt)],
      limit: 1,
    });

    return {
      tiers: {
        active: Number((counts as any)?.active ?? 0),
        lightweight: Number((counts as any)?.lightweight ?? 0),
        suppressed: Number((counts as any)?.suppressed ?? 0),
      },
      walletCoverage: Number((counts as any)?.wallet_coverage ?? 0),
      lastIndexedAt: lastJob?.finishedAt ?? null,
      lastJobStatus: lastJob?.status ?? null,
    };
  }

  async getMyHoldingsCollections(
    userId: string,
    tier: TrackingTier,
    page = 1,
    limit = 20,
  ) {
    const offset = (page - 1) * limit;

    const items = await this.db.execute(sql`
      SELECT
        c.id,
        c.name,
        c.chain,
        c.contract_address AS "contractAddress",
        c.image_url AS "imageUrl",
        c.tracking_tier AS tier,
        c.quality_score AS "qualityScore",
        c.quality_reason AS "qualityReason",
        p.name AS "projectName",
        p.slug AS "projectSlug",
        SUM(s.token_count)::int AS "tokenCount"
      FROM wallet_holdings_snapshots s
      INNER JOIN collections c
        ON c.chain = s.chain
       AND c.contract_address = s.contract_address
      LEFT JOIN projects p ON p.id = c.project_id
      WHERE s.user_id = ${userId}
        AND c.tracking_tier = ${tier}
      GROUP BY c.id, p.id
      ORDER BY SUM(s.token_count) DESC, c.last_seen_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    const [total] = await this.db.execute(sql`
      SELECT COUNT(DISTINCT c.id)::int AS total
      FROM wallet_holdings_snapshots s
      INNER JOIN collections c
        ON c.chain = s.chain
       AND c.contract_address = s.contract_address
      WHERE s.user_id = ${userId}
        AND c.tracking_tier = ${tier}
    `);

    return {
      items,
      total: Number((total as any)?.total ?? 0),
      page,
      limit,
      tier,
    };
  }
}
