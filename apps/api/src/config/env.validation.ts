import { plainToInstance, Type } from 'class-transformer';
import { IsString, IsOptional, IsNumber, validateSync, Min } from 'class-validator';

export class EnvironmentVariables {
  @IsString()
  DATABASE_URL: string = 'postgresql://postgres:password@localhost:5432/nexus';

  @IsString()
  JWT_SECRET: string = 'nexus-dev-secret-change-in-production';

  @IsNumber()
  @IsOptional()
  @Min(1)
  @Type(() => Number)
  API_PORT: number = 4000;

  @IsString()
  @IsOptional()
  NODE_ENV: string = 'development';

  @IsString()
  @IsOptional()
  REDIS_URL: string = 'redis://localhost:6379';

  @IsString()
  @IsOptional()
  ALCHEMY_API_KEY?: string;

  @IsString()
  @IsOptional()
  HELIUS_API_KEY?: string;

  @IsString()
  @IsOptional()
  SOLANA_RPC_URL?: string;

  @IsString()
  @IsOptional()
  TWITTER_BEARER_TOKEN?: string;

  @IsString()
  @IsOptional()
  OPENSEA_API_KEY?: string;

  @IsString()
  @IsOptional()
  RESERVOIR_API_KEY?: string;

  @IsNumber()
  @IsOptional()
  @Min(1)
  @Type(() => Number)
  HOLDINGS_MAX_COLLECTIONS_PER_RUN: number = 50;
}

export function validate(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(
      `Environment validation failed:\n${errors.map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`).join('\n')}`,
    );
  }
  return validated;
}
