import { Injectable, Inject } from '@nestjs/common';
import { ilike, or } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, projects, collections } from '@nexus/database';

@Injectable()
export class SearchService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async search(query: string, chain?: string) {
    const searchPattern = `%${query}%`;

    const projectResults = await this.db.query.projects.findMany({
      where: or(
        ilike(projects.name, searchPattern),
        ilike(projects.slug, searchPattern),
      ),
      limit: 10,
      with: { collections: true },
    });

    const collectionResults = await this.db.query.collections.findMany({
      where: or(
        ilike(collections.name, searchPattern),
        ilike(collections.contractAddress, searchPattern),
      ),
      limit: 10,
      with: { project: true },
    });

    return { projects: projectResults, collections: collectionResults };
  }
}
