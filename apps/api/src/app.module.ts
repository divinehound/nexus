import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './common/database/database.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { CollectionsModule } from './modules/collections/collections.module';
import { WikiModule } from './modules/wiki/wiki.module';
import { EventsModule } from './modules/events/events.module';
import { ActivityModule } from './modules/activity/activity.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { SearchModule } from './modules/search/search.module';
import { HealthScoreModule } from './modules/health-score/health-score.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import configuration from './config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    DatabaseModule,
    ProjectsModule,
    CollectionsModule,
    WikiModule,
    EventsModule,
    ActivityModule,
    DiscoveryModule,
    WalletsModule,
    SearchModule,
    HealthScoreModule,
    WebhooksModule,
  ],
})
export class AppModule {}
