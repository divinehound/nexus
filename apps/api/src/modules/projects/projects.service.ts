import { Injectable, Inject } from '@nestjs/common';
import { eq, desc, inArray } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, projects, projectAffinity } from '@nexus/database';

@Injectable()
export class ProjectsService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async findAll(page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    return this.db.query.projects.findMany({
      limit,
      offset,
      with: { collections: true },
    });
  }

  async findBySlug(slug: string) {
    return this.db.query.projects.findFirst({
      where: eq(projects.slug, slug),
      with: { collections: true, wiki: true, events: true },
    });
  }

  async getTrending() {
    return this.db.query.projects.findMany({
      limit: 10,
      orderBy: (projects, { desc }) => [desc(projects.healthScore)],
      with: { collections: true },
    });
  }

  async getOverlap(slug: string) {
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.slug, slug),
    });

    if (!project) return [];

    const affinities = await this.db.query.projectAffinity.findMany({
      where: eq(projectAffinity.projectAId, project.id),
      orderBy: [desc(projectAffinity.overlapPct)],
      limit: 10,
    });

    if (affinities.length === 0) return [];

    const relatedProjectIds = affinities.map((a) => a.projectBId);
    const relatedProjects = await this.db.query.projects.findMany({
      where: inArray(projects.id, relatedProjectIds),
      with: { collections: true },
    });

    const projectMap = new Map(relatedProjects.map((p) => [p.id, p]));

    return affinities
      .map((a) => ({
        project: projectMap.get(a.projectBId),
        overlapCount: a.overlapCount,
        overlapPct: a.overlapPct,
      }))
      .filter((item) => item.project);
  }
}
