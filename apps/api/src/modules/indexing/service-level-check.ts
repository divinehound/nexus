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
/** Gap between Alchemy calls. */
const CALL_GAP_MS = 250;

type Transfer = { blockNum: string; metadata?: { blockTimestamp?: string } };
export type CheckResult = { checked: number; failed: number; skipped: number; levels: Record<string, number> };

/**
 * Sets each collection's service level from its recent transfers, once a week:
 * - dormant: no transfer in 90 days;
 * - slow: under 30 transfers in the last 30 days;
 * - active: 30 or more;
 * - hot: the 100 busiest of those, or held by 10+ Nexus users.
 * Collections an admin pinned (premium always is) are left alone. Solana isn't counted yet.
 */
@Injectable()
export class ServiceLevelCheckService {
  private readonly logger = new Logger(ServiceLevelCheckService.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  async checkAll(): Promise<CheckResult> {
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
        const level = !seen.lastAt || seen.lastAt.getTime() < Date.now() - DORMANT_AFTER_DAYS * DAY_MS ? 'dormant' : seen.count >= ACTIVE_FROM ? 'active' : 'slow';
        const reason =
          level === 'dormant'
            ? seen.lastAt
              ? `No transfers since ${seen.lastAt.toISOString().slice(0, 10)}`
              : 'No transfers found'
            : `${seen.count >= PAGE ? `${PAGE}+` : seen.count} transfers in the last 30 days`;
        await this.db.execute(sql`
          UPDATE collections SET service_level = ${level}, service_level_reason = ${reason}, service_level_checked_at = now(),
            recent_transfers = ${seen.count}, last_transfer_at = ${seen.lastAt ? seen.lastAt.toISOString() : null}
          WHERE id = ${row.id} AND NOT service_level_pinned`);
        result.checked++;
      } catch (err) {
        result.failed++;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Service level check failed for ${row.chain}:${row.contract_address}: ${message}`);
        // Rate limited: stop here; the rest keep their levels until next week (or a manual run).
        if (/429|rate limit/i.test(message)) break;
      }
      await new Promise((r) => setTimeout(r, CALL_GAP_MS));
    }

    await this.markHot();
    const counts = await this.db.execute<{ level: string; n: number }>(sql`SELECT service_level::text AS level, count(*)::int AS n FROM collections GROUP BY 1`);
    for (const c of counts) result.levels[c.level] = c.n;
    this.logger.log(`Service level check: ${result.checked} checked, ${result.failed} failed, ${result.skipped} skipped; ${JSON.stringify(result.levels)}`);
    return result;
  }

  /** Promotes the busiest active collections and those many Nexus users hold to hot; hot ones that no longer qualify drop to active. */
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
               row_number() OVER (ORDER BY c.recent_transfers DESC NULLS LAST) AS rank
        FROM collections c
        LEFT JOIN held h ON h.chain = c.chain AND h.contract = lower(c.contract_address)
        WHERE NOT c.service_level_pinned AND c.service_level IN ('active', 'hot')
      )
      UPDATE collections c SET
        service_level = CASE WHEN r.rank <= ${HOT_TOP} OR r.users >= ${HOT_USERS} THEN 'hot'::service_level ELSE 'active'::service_level END,
        service_level_reason = CASE
          WHEN r.rank <= ${HOT_TOP} THEN r.base || ' (top ' || ${HOT_TOP} || ')'
          WHEN r.users >= ${HOT_USERS} THEN r.base || ' (held by ' || r.users || ' Nexus users)'
          ELSE r.base END
      FROM ranked r WHERE r.id = c.id`);
  }

  /**
   * The collection's transfers in the last 30 days (up to 1,000) and when its newest transfer
   * was, from one Alchemy call (newest first). Networks that leave out block timestamps get a
   * few block lookups instead.
   */
  async recentTransfers(rpcUrl: string, contract: string): Promise<{ count: number; lastAt: Date | null }> {
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
    if ((await timeOf(transfers[hi])).getTime() >= since) return { count: transfers.length, lastAt };
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((await timeOf(transfers[mid])).getTime() >= since) lo = mid;
      else hi = mid - 1;
    }
    return { count: lo + 1, lastAt };
  }
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) throw new Error('429 rate limited');
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string; code?: number } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? body.error.code}`);
  return body.result as T;
}

/** Queues the weekly check (Sundays 03:00 UTC) or one on demand; one at a time. */
@Injectable()
export class ServiceLevelCheckCron {
  constructor(@InjectQueue(SERVICE_LEVEL_QUEUE) private readonly queue: Queue) {}

  @Cron('0 3 * * 0', { timeZone: 'UTC' })
  async weekly() {
    await this.enqueue();
  }

  /** False when a check is already queued or running. */
  async enqueue(): Promise<boolean> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
    if ((counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) > 0) return false;
    await this.queue.add('check', {}, { deduplication: { id: 'service-level-check' }, attempts: 1, removeOnComplete: 20, removeOnFail: 20 });
    return true;
  }

  /** The last finished check, for the admin page. */
  async lastRun(): Promise<{ finishedAt: string | null; result: CheckResult | null; running: boolean }> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
    const [last] = await this.queue.getJobs(['completed'], 0, 0, false);
    return {
      running: (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) > 0,
      finishedAt: last?.finishedOn ? new Date(last.finishedOn).toISOString() : null,
      result: (last?.returnvalue as CheckResult | undefined) ?? null,
    };
  }
}

// A check of thousands of collections runs for a long time: a long lock keeps it from being taken for stalled.
@Processor(SERVICE_LEVEL_QUEUE, { concurrency: 1, lockDuration: 10 * 60_000 })
export class ServiceLevelCheckProcessor extends WorkerHost {
  constructor(private readonly check: ServiceLevelCheckService) {
    super();
  }

  async process(_job: Job): Promise<CheckResult> {
    return this.check.checkAll();
  }
}
