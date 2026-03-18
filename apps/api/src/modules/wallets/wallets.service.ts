import { Injectable, Inject } from '@nestjs/common';
import { eq, and, inArray } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, wallets, holders, collections, events, activityFeed } from '@nexus/database';

@Injectable()
export class WalletsService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async connectWallet(address: string, chain: string) {
    const existing = await this.db.query.wallets.findFirst({
      where: eq(wallets.address, address),
    });
    if (existing) {
      await this.db
        .update(wallets)
        .set({ lastSyncedAt: new Date() })
        .where(eq(wallets.id, existing.id));
      return existing;
    }

    const [wallet] = await this.db
      .insert(wallets)
      .values({ address, chain: chain as any })
      .returning();
    return wallet;
  }

  async getHoldings(address: string) {
    const held = await this.db.query.holders.findMany({
      where: and(eq(holders.walletAddress, address), eq(holders.isCurrent, true)),
    });

    if (held.length === 0) return [];

    const collectionIds = [...new Set(held.map((h) => h.collectionId))];
    const collectionRows = await this.db.query.collections.findMany({
      where: inArray(collections.id, collectionIds),
      with: { project: true },
    });

    const collectionMap = new Map(collectionRows.map((c) => [c.id, c]));

    // Group holdings by project
    const projectMap = new Map<string, { project: (typeof collectionRows)[0]['project']; collections: { collection: (typeof collectionRows)[0]; quantity: number }[] }>();

    for (const h of held) {
      const col = collectionMap.get(h.collectionId);
      if (!col) continue;
      const proj = col.project;
      if (!projectMap.has(proj.id)) {
        projectMap.set(proj.id, { project: proj, collections: [] });
      }
      projectMap.get(proj.id)!.collections.push({
        collection: col,
        quantity: h.quantity,
      });
    }

    return Array.from(projectMap.values());
  }

  async getMyEvents(address: string) {
    const projectIds = await this.getHeldProjectIds(address);
    if (projectIds.length === 0) return [];

    return this.db.query.events.findMany({
      where: and(
        inArray(events.projectId, projectIds),
        eq(events.status, 'upcoming'),
      ),
      orderBy: (events, { asc }) => [asc(events.startTime)],
      limit: 50,
    });
  }

  async getMyActivity(address: string) {
    const projectIds = await this.getHeldProjectIds(address);
    if (projectIds.length === 0) return [];

    return this.db.query.activityFeed.findMany({
      where: inArray(activityFeed.projectId, projectIds),
      orderBy: (activityFeed, { desc }) => [desc(activityFeed.createdAt)],
      limit: 50,
      with: { reactions: true },
    });
  }

  private async getHeldProjectIds(address: string): Promise<string[]> {
    const held = await this.db.query.holders.findMany({
      where: and(eq(holders.walletAddress, address), eq(holders.isCurrent, true)),
    });

    if (held.length === 0) return [];

    const collectionIds = [...new Set(held.map((h) => h.collectionId))];
    const cols = await this.db.query.collections.findMany({
      where: inArray(collections.id, collectionIds),
    });

    return [...new Set(cols.map((c) => c.projectId))];
  }
}
