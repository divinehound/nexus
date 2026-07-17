import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, inArray, lt } from 'drizzle-orm';
import {
  type Database,
  indexingJobs,
  walletIndexingJobs,
  walletLinkChallenges,
  walletMoveConfirmations,
} from '@nexus/database';
import { DATABASE_TOKEN } from '../../common/database/database.module';

const JOB_RETENTION_DAYS = 30;

/**
 * Nightly cleanup of append-only bookkeeping tables. Job rows are an audit
 * trail, not queue state (BullMQ holds execution state with its own
 * retention), so trimming finished rows after 30 days loses nothing.
 * Queued/running rows are kept regardless of age. Wallet-link challenges and
 * move confirmations are single-use rows that expire within minutes; a day
 * past expiry is a generous debugging window.
 */
@Injectable()
export class RetentionCron {
  private readonly logger = new Logger(RetentionCron.name);

  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async pruneExpiredRows() {
    const jobCutoff = new Date(Date.now() - JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const authCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const finishedStatuses = ['completed', 'failed'] as const;

    const walletJobs = await this.db
      .delete(walletIndexingJobs)
      .where(
        and(
          inArray(walletIndexingJobs.status, [...finishedStatuses]),
          lt(walletIndexingJobs.startedAt, jobCutoff),
        ),
      )
      .returning({ id: walletIndexingJobs.id });

    const generalJobs = await this.db
      .delete(indexingJobs)
      .where(
        and(
          inArray(indexingJobs.status, [...finishedStatuses]),
          lt(indexingJobs.startedAt, jobCutoff),
        ),
      )
      .returning({ id: indexingJobs.id });

    const challenges = await this.db
      .delete(walletLinkChallenges)
      .where(lt(walletLinkChallenges.expiresAt, authCutoff))
      .returning({ id: walletLinkChallenges.id });

    const confirmations = await this.db
      .delete(walletMoveConfirmations)
      .where(lt(walletMoveConfirmations.expiresAt, authCutoff))
      .returning({ id: walletMoveConfirmations.id });

    const total =
      walletJobs.length + generalJobs.length + challenges.length + confirmations.length;
    if (total > 0) {
      this.logger.log(
        `Retention prune: ${walletJobs.length} wallet jobs, ${generalJobs.length} indexing jobs, ` +
          `${challenges.length} link challenges, ${confirmations.length} move confirmations removed`,
      );
    }
  }
}
