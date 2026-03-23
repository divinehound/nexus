import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  type Database,
  collections,
  collectionHolders,
  collectionHolderHistory,
  collectionDailyMetrics,
} from '@nexus/database';

/**
 * Service for creating daily snapshots of collection holder data
 * Tracks joins, exits, and changes over time
 */
@Injectable()
export class HolderSnapshotService {
  private readonly logger = new Logger(HolderSnapshotService.name);

  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  /**
   * Create a daily snapshot for a collection
   * Compares current holders vs previous snapshot to detect changes
   */
  async createDailySnapshot(collectionId: string, snapshotDate: Date): Promise<{
    success: boolean;
    joins: number;
    exits: number;
    increases: number;
    decreases: number;
  }> {
    this.logger.log(`Creating daily snapshot for collection ${collectionId} on ${snapshotDate.toISOString()}`);

    try {
      // Get current holders
      const currentHolders = await this.db.query.collectionHolders.findMany({
        where: eq(collectionHolders.collectionId, collectionId),
      });

      // Get previous day's snapshot
      const previousDate = new Date(snapshotDate);
      previousDate.setDate(previousDate.getDate() - 1);

      const previousSnapshot = await this.db.query.collectionHolderHistory.findMany({
        where: and(
          eq(collectionHolderHistory.collectionId, collectionId),
          eq(collectionHolderHistory.snapshotDate, previousDate as any),
        ),
      });

      const previousMap = new Map(
        previousSnapshot.map((h) => [h.address, h.tokenCount]),
      );

      let joins = 0;
      let exits = 0;
      let increases = 0;
      let decreases = 0;

      // Detect changes
      const historyEntries = [];
      for (const holder of currentHolders) {
        const previousCount = previousMap.get(holder.address);

        if (previousCount === undefined) {
          // New holder
          joins++;
          historyEntries.push({
            collectionId,
            address: holder.address,
            tokenCount: holder.tokenCount,
            snapshotDate: snapshotDate as any,
            eventType: 'join' as const,
          });
        } else if (holder.tokenCount > previousCount) {
          // Increased holdings
          increases++;
          historyEntries.push({
            collectionId,
            address: holder.address,
            tokenCount: holder.tokenCount,
            snapshotDate: snapshotDate as any,
            eventType: 'increase' as const,
          });
        } else if (holder.tokenCount < previousCount) {
          // Decreased holdings
          decreases++;
          historyEntries.push({
            collectionId,
            address: holder.address,
            tokenCount: holder.tokenCount,
            snapshotDate: snapshotDate as any,
            eventType: 'decrease' as const,
          });
        } else {
          // No change, still record for continuity
          historyEntries.push({
            collectionId,
            address: holder.address,
            tokenCount: holder.tokenCount,
            snapshotDate: snapshotDate as any,
            eventType: null,
          });
        }

        previousMap.delete(holder.address);
      }

      // Remaining in previousMap = exited holders
      for (const [address, tokenCount] of previousMap.entries()) {
        exits++;
        historyEntries.push({
          collectionId,
          address,
          tokenCount: 0,
          snapshotDate: snapshotDate as any,
          eventType: 'exit' as const,
        });
      }

      // Insert history entries
      if (historyEntries.length > 0) {
        await this.db.insert(collectionHolderHistory).values(historyEntries);
      }

      // Calculate aggregate metrics
      const totalTokens = currentHolders.reduce((sum, h) => sum + h.tokenCount, 0);
      const avgTokens = currentHolders.length > 0 ? totalTokens / currentHolders.length : 0;

      await this.db
        .insert(collectionDailyMetrics)
        .values({
          collectionId,
          metricDate: snapshotDate as any,
          holderCount: currentHolders.length,
          newHolders: joins,
          exitedHolders: exits,
          totalTokensHeld: totalTokens,
          avgTokensPerHolder: avgTokens.toFixed(2),
        })
        .onConflictDoUpdate({
          target: [collectionDailyMetrics.collectionId, collectionDailyMetrics.metricDate],
          set: {
            holderCount: currentHolders.length,
            newHolders: joins,
            exitedHolders: exits,
            totalTokensHeld: totalTokens,
            avgTokensPerHolder: avgTokens.toFixed(2),
          },
        });

      this.logger.log(
        `Snapshot complete: ${joins} joins, ${exits} exits, ${increases} increases, ${decreases} decreases`,
      );

      return { success: true, joins, exits, increases, decreases };
    } catch (error: any) {
      this.logger.error(`Failed to create snapshot for collection ${collectionId}:`, error);
      return { success: false, joins: 0, exits: 0, increases: 0, decreases: 0 };
    }
  }

  /**
   * Create snapshots for all indexed collections
   * Should be run daily via cron job
   */
  async createAllSnapshots(snapshotDate?: Date): Promise<{
    success: boolean;
    snapshotsCreated: number;
    errors: number;
  }> {
    const date = snapshotDate || new Date();
    this.logger.log(`Creating daily snapshots for all collections on ${date.toISOString()}`);

    // Get all collections with full index status
    const indexedCollections = await this.db.query.collections.findMany({
      where: eq(collections.indexStatus, 'full'),
    });

    let created = 0;
    let errors = 0;

    for (const collection of indexedCollections) {
      const result = await this.createDailySnapshot(collection.id, date);
      if (result.success) {
        created++;
      } else {
        errors++;
      }
    }

    this.logger.log(`Snapshots complete: ${created} created, ${errors} errors`);
    return { success: errors === 0, snapshotsCreated: created, errors };
  }
}
