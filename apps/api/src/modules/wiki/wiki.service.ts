import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, projectWiki, wikiSuggestions } from '@nexus/database';

@Injectable()
export class WikiService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async getByProjectId(projectId: string) {
    return this.db.query.projectWiki.findFirst({
      where: eq(projectWiki.projectId, projectId),
    });
  }

  async submitSuggestion(
    projectId: string,
    data: { field: string; proposedValue: string; submittedBy: string },
  ) {
    const [suggestion] = await this.db
      .insert(wikiSuggestions)
      .values({
        projectId,
        field: data.field,
        proposedValue: data.proposedValue,
        submittedBy: data.submittedBy,
      })
      .returning();
    return suggestion;
  }
}
