-- Add new EVM chains to the chain enum
ALTER TYPE "chain" ADD VALUE IF NOT EXISTS 'base';
ALTER TYPE "chain" ADD VALUE IF NOT EXISTS 'abstract';
ALTER TYPE "chain" ADD VALUE IF NOT EXISTS 'apechain';
ALTER TYPE "chain" ADD VALUE IF NOT EXISTS 'polygon';
