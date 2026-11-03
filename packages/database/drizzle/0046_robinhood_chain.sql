-- Robinhood Chain (EVM, chain id 4663). New enum values go at the end.
ALTER TYPE "chain" ADD VALUE IF NOT EXISTS 'robinhood';
--> statement-breakpoint
-- collection_holders.chain is TEXT with a CHECK listing every chain (0013). Drop it rather than
-- repeat the list: rows always copy the chain of their collection, which is the chain enum.
ALTER TABLE "collection_holders" DROP CONSTRAINT IF EXISTS "collection_holders_chain_check";
