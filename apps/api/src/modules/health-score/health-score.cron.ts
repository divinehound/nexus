import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, projects } from '@nexus/database';
import { HealthScoreService } from './health-score.service';

@Injectable()
export class HealthScoreCron {
  private readonly logger = new Logger(HealthScoreCron.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly healthScoreService: HealthScoreService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async recomputeAllScores() {
    this.logger.log('Starting health score recomputation…');

    const allProjects = await this.db.query.projects.findMany({
      columns: { id: true, slug: true },
    });

    let updated = 0;
    for (const project of allProjects) {
      try {
        await this.healthScoreService.computeHealthScore(project.id);
        updated++;
      } catch (err) {
        this.logger.error(
          `Failed to compute health score for ${project.slug}: ${err}`,
        );
      }
    }

    this.logger.log(`Health scores updated for ${updated}/${allProjects.length} projects`);
  }
}
