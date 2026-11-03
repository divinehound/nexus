import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Job, Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { CHAIN_META } from '@nexus/types';
import { type Database } from '@nexus/database';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { SERVICE_LEVEL_QUEUE } from '../../common/queue/queues';
import { chainIsOn } from './chain-switches';

const DAY_MS = 24 * 60 * 60 * 1000;
/** No transfer for this long: dormant. */
const DORMANT_AFTER_DAYS = 90;
/** Transfers in the last 30 days that make a collection active rather than slow. */
const ACTIVE_FROM = 30;
/** The busiest collections by transfers become hot... */
const HOT_TOP = 100;
/** ...and so does any collection this many Nexus users hold. */
const HOT_USERS = 10;
/** One transfers call per collection reads at most this many (the newest first). */
const PAGE = 1000;
/** Gap between Alchemy calls (and between block lookups on networks without timestamps). */
const CALL_GAP_MS = 250;
const BLOCK_GAP_MS = 100;
/** Errors that mean Alchemy wants us to slow down: stop the run rather than burn through the list. */
const RATE_LIMITED = /\b429\b|rate limit|capacity|too many requests|compute units/i;

type Transfer = { blockNum: string; metadata?: { blockTimestamp?: string } };
export type CheckResult = { checked: number; failed: number; skipped: number; levels: Record<string, number> };

/**
 * Sets each collection's service level from its recent transfers, once a week:
 * - dormant: no transfer in 90 days;
 * - slow: under 30 transfers in the last 30 days;
 * - active: 30 or more;
 * - hot: the 100 busiest of those, or held by 10+ Nexus users.
 * Collections an admin pinned (premium always is) are left alone. Solana isn't counted yet.
 * A smaller daily run checks only collections never checked (new, or just unpinned), so they
 * don't wait up to a week. A run cut short by a restart starts over from the least recently
 * checked, so it picks up where it stopped.
 */
@Injectable()
export class ServiceLevelCheckService {
  private readonly logger = new Logger(ServiceLevelCheckService.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  async checkAll(opts: { onlyUnchecked?: boolean } = {}): Promise<CheckResult> {
    const key = this.config.get<string>('alchemy.apiKey');
    const rows = [
      ...(await this.db.execute<{ id: string; chain: string; contract_address: string }>(sql`
        SELECT c.id, c.chain::text AS chain, c.contract_address
        FROM collections c
        WHERE NOT c.service_level_pinned
          AND c.chain <> 'solana'
          AND c.is_spam IS NOT TRUE
          AND c.verification_status != 'rejected'
          AND c.tracking_tier != 'suppressed'
          AND ${chainIsOn(sql`c.chain`)}
          ${opts.onlyUnchecked ? sql`AND c.service_level_checked_at IS NULL` : sql``}
        ORDER BY c.service_level_checked_at ASC NULLS FIRST`)),
    ];
    const result: CheckResult = { checked: 0, failed: 0, skipped: 0, levels: {} };

    // Spam, rejected and suppressed collections never refresh on their own.
    await this.db.execute(sql`
      UPDATE collections c SET service_level = 'dormant', service_level_reason = 'Spam, rejected or suppressed', service_level_checked_at = now()
      WHERE NOT c.service_level_pinned AND c.service_level <> 'dormant'
        AND (c.is_spam IS TRUE OR c.verification_status = 'rejected' OR c.tracking_tier = 'suppressed')`);

    for (const row of rows) {
      const meta = CHAIN_META[row.chain as keyof typeof CHAIN_META];
      if (!key || !meta?.alchemySubdomain) {
        result.skipped++;
        continue;
      }
      try {
        const seen = await this.recentTransfers(`https://${meta.alchemySubdomain}.g.alchemy.com/v2/${key}`, row.contract_address);
        const level: 'dormant' | 'slow' | 'active' = !seen.lastAt || seen.lastAt.getTime() < Date.now() - DORMANT_AFTER_DAYS * DAY_MS ? 'dormant' : seen.count >= ACTIVE_FROM ? 'active' : 'slow';
        const reason =
          level === 'dormant'
            ? seen.lastAt
              ? `No transfers since ${seen.lastAt.toISOString().slice(0, 10)}`
              : 'No transfers found'
            : seen.estimated
              ? `About ${seen.count.toLocaleString('en-US')} transfers in the last 30 days (estimated from the newest ${PAGE})`
              : `${seen.count} transfers in the last 30 days`;
        // A hot collection that is still active stays hot here; markHot below decides whether it keeps it.
        await this.db.execute(sql`
          UPDATE collections SET
            service_level = CASE WHEN service_level = 'hot' AND ${level} = 'active' THEN 'hot'::service_level ELSE ${level}::service_level END,
            service_level_reason = ${reason}, service_level_checked_at = now(),
            recent_transfers = ${seen.count}, last_transfer_at = ${seen.lastAt ? seen.lastAt.toISOString() : null}
          WHERE id = ${row.id} AND NOT service_level_pinned`);
        result.checked++;
      } catch (err) {
        result.failed++;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Service level check failed for ${row.chain}:${row.contract_address}: ${message}`);
        // Rate limited: stop here; the rest keep their levels until next week (or a manual run).
        if (RATE_LIMITED.test(message)) break;
      }
      await new Promise((r) => setTimeout(r, CALL_GAP_MS));
    }

    await this.markHot();
    const counts = await this.db.execute<{ level: string; n: number }>(sql`SELECT service_level::text AS level, count(*)::int AS n FROM collections GROUP BY 1`);
    for (const c of counts) result.levels[c.level] = c.n;
    this.logger.log(`Service level check: ${result.checked} checked, ${result.failed} failed, ${result.skipped} skipped; ${JSON.stringify(result.levels)}`);
    return result;
  }

  /**
   * Promotes the busiest active collections, and slow or active ones many Nexus users hold, to
   * hot; hot ones that no longer qualify drop to active. Dormant ones stay dormant: with no
   * transfers their holders don't change.
   */
  private async markHot() {
    await this.db.execute(sql`
      WITH held AS (
        SELECT s.chain, lower(s.contract_address) AS contract, count(DISTINCT s.user_id) AS users
        FROM wallet_holdings_snapshots s GROUP BY 1, 2
      ),
      ranked AS (
        SELECT c.id, coalesce(h.users, 0) AS users,
               -- Last week's "(top 100)" / "(held by …)" note comes off before this week's goes on.
               regexp_replace(coalesce(c.service_level_reason, ''), ' \\((top|held by) [^)]*\\)$', '') AS base,
               -- Only active and hot collections compete for the top 100.
               CASE WHEN c.service_level IN ('active', 'hot')
                    THEN row_number() OVER (PARTITION BY c.service_level IN ('active', 'hot') ORDER BY c.recent_transfers DESC NULLS LAST, c.last_transfer_at DESC NULLS LAST)
               END AS rank
        FROM collections c
        LEFT JOIN held h ON h.chain = c.chain AND h.contract = lower(c.contract_address)
        WHERE NOT c.service_level_pinned AND c.service_level IN ('slow', 'active', 'hot')
      )
      UPDATE collections c SET
        service_level = CASE
          WHEN r.rank <= ${HOT_TOP} OR r.users >= ${HOT_USERS} THEN 'hot'::service_level
          WHEN c.service_level = 'hot' THEN 'active'::service_level
          ELSE c.service_level END,
        service_level_reason = CASE
          WHEN r.rank <= ${HOT_TOP} THEN r.base || ' (top ' || ${HOT_TOP} || ')'
          WHEN r.users >= ${HOT_USERS} THEN r.base || ' (held by ' || r.users || ' Nexus users)'
          ELSE r.base END
      FROM ranked r WHERE r.id = c.id
        AND (c.service_level <> 'slow' OR r.users >= ${HOT_USERS})`);
  }

  /**
   * The collection's transfers in the last 30 days and when its newest transfer was, from one
   * Alchemy call (newest first). When all 1,000 returned fall within 30 days, the count is
   * estimated from how long those 1,000 took, so the busiest collections still rank in order.
   * Networks that leave out block timestamps get a few block lookups instead.
   */
  async recentTransfers(rpcUrl: string, contract: string): Promise<{ count: number; lastAt: Date | null; estimated?: boolean }> {
    const res = await rpc<{ transfers: Transfer[] }>(rpcUrl, 'alchemy_getAssetTransfers', [
      {
        fromBlock: '0x0',
        toBlock: 'latest',
        contractAddresses: [contract],
        category: ['erc721', 'erc1155', 'erc20'],
        order: 'desc',
        withMetadata: true,
        excludeZeroValue: false,
        maxCount: `0x${PAGE.toString(16)}`,
      },
    ]);
    const transfers = res.transfers ?? [];
    if (!transfers.length) return { count: 0, lastAt: null };

    const cache = new Map<string, Date>();
    const timeOf = async (t: Transfer): Promise<Date> => {
      const stamped = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp) : null;
      if (stamped && !Number.isNaN(stamped.getTime())) return stamped;
      const hit = cache.get(t.blockNum);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, BLOCK_GAP_MS));
      const block = await rpc<{ timestamp: string }>(rpcUrl, 'eth_getBlockByNumber', [t.blockNum, false]);
      const at = new Date(Number.parseInt(block.timestamp, 16) * 1000);
      cache.set(t.blockNum, at);
      return at;
    };

    const since = Date.now() - 30 * DAY_MS;
    const lastAt = await timeOf(transfers[0]);
    if (lastAt.getTime() < since) return { count: 0, lastAt };
    // Newest first: find how many are within 30 days (a binary search, so few lookups without timestamps).
    let lo = 0;
    let hi = transfers.length - 1;
    const oldest = await timeOf(transfers[hi]);
    if (oldest.getTime() >= since) {
      if (transfers.length < PAGE) return { count: transfers.length, lastAt };
      // A full page inside 30 days: scale up by the time it covers (at least an hour, so a burst can't explode it).
      const span = Math.max(Date.now() - oldest.getTime(), 60 * 60 * 1000);
      return { count: Math.max(PAGE, Math.round((PAGE * 30 * DAY_MS) / span)), lastAt, estimated: true };
    }
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((await timeOf(transfers[mid])).getTime() >= since) lo = mid;
      else hi = mid - 1;
    }
    return { count: lo + 1, lastAt };
  }
}

async function rpc<T>(url: string, method: string, params: unknown[], retried = false): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) throw new Error('429 rate limited');
  // One retry on a server error before giving up on this collection.
  if (res.status >= 500 && !retried) {
    await new Promise((r) => setTimeout(r, 2000));
    return rpc<T>(url, method, params, true);
  }
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string; code?: number } };
  if (body.error) throw new Error(`${method}: ${body.error.code === 429 ? '429 ' : ''}${body.error.message ?? body.error.code}`);
  return body.result as T;
}

/**
 * Queues the weekly check (Sundays 03:00 UTC) or one on demand, and every other day at 03:00
 * a check of only the collections never checked; one at a time.
 */
@Injectable()
export class ServiceLevelCheckCron {
  constructor(@InjectQueue(SERVICE_LEVEL_QUEUE) private readonly queue: Queue) {}

  @Cron('0 3 * * 0', { timeZone: 'UTC' })
  async weekly() {
    await this.enqueue();
  }

  @Cron('0 3 * * 1-6', { timeZone: 'UTC' })
  async daily() {
    await this.enqueue(true);
  }

  /** False when a check is already queued or running. */
  async enqueue(onlyUnchecked = false): Promise<boolean> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
    if ((counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) > 0) return false;
    await this.queue.add(
      onlyUnchecked ? 'check-new' : 'check',
      { onlyUnchecked },
      { deduplication: { id: 'service-level-check' }, attempts: 1, removeOnComplete: 20, removeOnFail: 20 },
    );
    return true;
  }

  /** The last full check that finished or failed, for the admin page. */
  async lastRun(): Promise<{ finishedAt: string | null; result: CheckResult | null; error: string | null; running: boolean }> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
    const jobs = (await this.queue.getJobs(['completed', 'failed'], 0, 40, false)).filter((j) => j.name === 'check' && j.finishedOn);
    const last = jobs.sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0))[0];
    return {
      running: (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) > 0,
      finishedAt: last?.finishedOn ? new Date(last.finishedOn).toISOString() : null,
      result: last?.failedReason ? null : ((last?.returnvalue as CheckResult | undefined) ?? null),
      error: last?.failedReason ?? null,
    };
  }
}

// A check of thousands of collections runs for a long time: a long lock keeps it from being taken for stalled.
@Processor(SERVICE_LEVEL_QUEUE, { concurrency: 1, lockDuration: 10 * 60_000 })
export class ServiceLevelCheckProcessor extends WorkerHost {
  constructor(private readonly check: ServiceLevelCheckService) {
    super();
  }

  async process(job: Job<{ onlyUnchecked?: boolean }>): Promise<CheckResult> {
    return this.check.checkAll({ onlyUnchecked: job.data?.onlyUnchecked === true });
  }
}
