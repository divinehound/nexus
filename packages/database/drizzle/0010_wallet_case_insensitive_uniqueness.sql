-- Prevent case-variant duplicate wallet records for EVM-style chains.
-- Solana addresses remain case-sensitive and are excluded.

-- 1) Merge duplicates by (chain, lower(address)) for non-solana chains,
-- keeping a canonical row using deterministic text ordering of UUID.
WITH canonical AS (
  SELECT DISTINCT ON (chain, lower(address))
    id AS keep_id,
    chain,
    lower(address) AS addr_lc
  FROM wallets
  WHERE chain <> 'solana'
  ORDER BY chain, lower(address), id::text
), dups AS (
  SELECT w.id AS dup_id, c.keep_id
  FROM wallets w
  JOIN canonical c
    ON w.chain = c.chain
   AND lower(w.address) = c.addr_lc
  WHERE w.id <> c.keep_id
)
UPDATE wallet_indexing_jobs j
SET wallet_id = d.keep_id
FROM dups d
WHERE j.wallet_id = d.dup_id;

WITH canonical AS (
  SELECT DISTINCT ON (chain, lower(address))
    id AS keep_id,
    chain,
    lower(address) AS addr_lc
  FROM wallets
  WHERE chain <> 'solana'
  ORDER BY chain, lower(address), id::text
), dups AS (
  SELECT w.id AS dup_id, c.keep_id
  FROM wallets w
  JOIN canonical c
    ON w.chain = c.chain
   AND lower(w.address) = c.addr_lc
  WHERE w.id <> c.keep_id
)
UPDATE wallet_holdings_snapshots s
SET wallet_id = d.keep_id
FROM dups d
WHERE s.wallet_id = d.dup_id;

WITH canonical AS (
  SELECT DISTINCT ON (chain, lower(address))
    id AS keep_id,
    chain,
    lower(address) AS addr_lc
  FROM wallets
  WHERE chain <> 'solana'
  ORDER BY chain, lower(address), id::text
), dups AS (
  SELECT w.id AS dup_id
  FROM wallets w
  JOIN canonical c
    ON w.chain = c.chain
   AND lower(w.address) = c.addr_lc
  WHERE w.id <> c.keep_id
)
DELETE FROM wallets w
USING dups d
WHERE w.id = d.dup_id;

-- 2) Add case-insensitive uniqueness guard.
CREATE UNIQUE INDEX IF NOT EXISTS wallets_chain_address_ci_unique
  ON wallets (chain, lower(address))
  WHERE chain <> 'solana';
