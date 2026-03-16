import { Injectable, Inject } from '@nestjs/common';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database } from '@nexus/database';

@Injectable()
export class HealthScoreService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async computeHealthScore(projectId: string): Promise<number> {
    // TODO: Implement composite health score (0-100)
    // Signals: holder growth rate, diamond hand ratio, trading activity,
    // listing ratio, social signals, multi-collection engagement,
    // event frequency, activity feed volume
    return 0;
  }
}
