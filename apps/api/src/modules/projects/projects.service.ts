import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, projects } from '@nexus/database';

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
    // TODO: Implement trending logic based on search volume / holder growth
    return this.db.query.projects.findMany({
      limit: 10,
      orderBy: (projects, { desc }) => [desc(projects.healthScore)],
    });
  }

  async getOverlap(slug: string) {
    // TODO: Implement overlap query via project_affinity table
    return [];
  }
}
