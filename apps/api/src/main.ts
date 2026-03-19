import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { runMigrations } from '@nexus/database';

async function bootstrap() {
  if (process.env.DATABASE_URL) {
    await runMigrations(process.env.DATABASE_URL);
  }

  const app = await NestFactory.create(AppModule);

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
