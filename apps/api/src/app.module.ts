import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
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
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { MeModule } from './modules/me/me.module';
import { HoldingsModule } from './modules/holdings/holdings.module';
import configuration from './config/configuration';
import { validate } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate,
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    DatabaseModule,
    AuthModule,
    AdminModule,
    MeModule,
    HoldingsModule,
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
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
