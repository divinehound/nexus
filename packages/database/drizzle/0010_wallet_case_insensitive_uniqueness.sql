-- Prevent case-variant duplicate wallet records for EVM-style chains.
-- Solana addresses remain case-sensitive and are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS wallets_chain_address_ci_unique
  ON wallets (chain, lower(address))
  WHERE chain <> 'solana';
