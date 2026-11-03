-- Opt-in per project: look up internal ETH payouts when pricing non-Seaport NFT sales in holder history.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "exact_sale_payouts" boolean DEFAULT false NOT NULL;
