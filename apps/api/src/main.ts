import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { runMigrations } from '@nexus/database';

async function bootstrap() {
  const shouldRunMigrations = (process.env.RUN_MIGRATIONS_ON_BOOT ?? 'true') === 'true';

  if (shouldRunMigrations && process.env.DATABASE_URL) {
    console.log('🔄 Running database migrations...');
    try {
      await runMigrations(process.env.DATABASE_URL);
      console.log('✅ Database migrations completed successfully');
    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error; // Don't start the server if migrations fail
    }
  } else {
    console.log('⚠️  Skipping migrations:', { shouldRunMigrations, hasDatabaseUrl: !!process.env.DATABASE_URL });
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // The web app proxies /api here over the private network. Trust forwarded
  // client IPs only from private-network peers, so rate limits apply per
  // visitor instead of to everyone behind the proxy, and can't be spoofed
  // by a client that reaches the API directly.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  // Close BullMQ workers gracefully on SIGTERM/SIGINT so in-flight jobs
  // finish (or release their locks for another instance to pick up).
  app.enableShutdownHooks();

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.WEB_URL || 'http://localhost:3000',
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  const config = new DocumentBuilder()
    .setTitle('NEXUS API')
    .setDescription('The Dexscreener for NFT Projects & Communities')
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.API_PORT || 4000;
  await app.listen(port);
  console.log(`NEXUS API running on http://localhost:${port}`);
}

bootstrap();
