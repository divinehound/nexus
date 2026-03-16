import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDatabase } from '@nexus/database';

export const DATABASE_TOKEN = 'DATABASE';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('database.url');
        if (!url) throw new Error('DATABASE_URL is not configured');
        return createDatabase(url);
      },
    },
  ],
  exports: [DATABASE_TOKEN],
})
export class DatabaseModule {}
