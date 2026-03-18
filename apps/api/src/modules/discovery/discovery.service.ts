import { Injectable, Inject } from '@nestjs/common';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  type Database,
  holders,
  collections,
  projects,
  projectAffinity,
} from '@nexus/database';

@Injectable()
export class DiscoveryService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async getRecommendations(walletAddress: string) {
    // Get collections the wallet holds
    const held = await this.db.query.holders.findMany({
      where: and(eq(holders.walletAddress, walletAddress), eq(holders.isCurrent, true)),
    });

    if (held.length === 0) return [];

    const collectionIds = [...new Set(held.map((h) => h.collectionId))];
    const cols = await this.db.query.collections.findMany({
      where: inArray(collections.id, collectionIds),
    });

    const heldProjectIds = [...new Set(cols.map((c) => c.projectId))];
    if (heldProjectIds.length === 0) return [];

    // Find projects with high holder overlap via projectAffinity
    const affinities = await this.db.query.projectAffinity.findMany({
      where: inArray(projectAffinity.projectAId, heldProjectIds),
      orderBy: [desc(projectAffinity.overlapCount)],
      limit: 30,
    });

    // Filter out already-held projects
    const recommendedProjectIds = [
      ...new Set(
        affinities
          .map((a) => a.projectBId)
          .filter((id) => !heldProjectIds.includes(id)),
      ),
    ].slice(0, 10);

    if (recommendedProjectIds.length === 0) return [];

    const recommendedProjects = await this.db.query.projects.findMany({
      where: inArray(projects.id, recommendedProjectIds),
      with: { collections: true },
    });

    const affinityMap = new Map(affinities.map((a) => [a.projectBId, a]));

    return recommendedProjects.map((p) => ({
      project: p,
      overlapCount: affinityMap.get(p.id)?.overlapCount ?? 0,
      overlapPct: affinityMap.get(p.id)?.overlapPct ?? 0,
    }));
  }

  async getEchoScore(walletAddress: string) {
    const held = await this.db.query.holders.findMany({
      where: and(eq(holders.walletAddress, walletAddress), eq(holders.isCurrent, true)),
    });

    if (held.length === 0) {
      return { walletAddress, echoScore: null, label: null };
    }

    const collectionIds = [...new Set(held.map((h) => h.collectionId))];
    const cols = await this.db.query.collections.findMany({
      where: inArray(collections.id, collectionIds),
    });

    const heldProjectIds = [...new Set(cols.map((c) => c.projectId))];
    const heldProjects = await this.db.query.projects.findMany({
      where: inArray(projects.id, heldProjectIds),
    });

    const clusterIds = heldProjects
      .map((p) => p.clusterId)
      .filter((id): id is string => id !== null);

    if (clusterIds.length === 0) {
      return { walletAddress, echoScore: 50, label: 'Explorer' };
    }

    // Echo score: 100 = very insular (all in 1 cluster), 0 = very diverse
    const uniqueClusters = new Set(clusterIds).size;
    const totalProjects = heldProjects.length;
    const diversityRatio = uniqueClusters / Math.max(totalProjects, 1);
    const echoScore = Math.round((1 - diversityRatio) * 100);

    let label: string;
    if (echoScore >= 80) label = 'Echo Chamber';
    else if (echoScore >= 60) label = 'Niche Collector';
    else if (echoScore >= 40) label = 'Balanced';
    else if (echoScore >= 20) label = 'Explorer';
    else label = 'Trailblazer';

    return { walletAddress, echoScore, label };
  }
}
