-- Prevent case-variant duplicate wallet records for EVM-style chains.
-- Solana addresses remain case-sensitive and are excluded.

-- 1) Merge duplicates by (chain, lower(address)) for non-solana chains,
-- keeping a canonical row (lexicographically smallest UUID).
WITH groups AS (
  SELECT chain, lower(address) AS addr_lc, min(id) AS keep_id
  FROM wallets
  WHERE chain <> 'solana'
  GROUP BY chain, lower(address)
  HAVING count(*) > 1
), dups AS (
  SELECT w.id AS dup_id, g.keep_id
  FROM wallets w
  JOIN groups g
    ON w.chain = g.chain
   AND lower(w.address) = g.addr_lc
  WHERE w.id <> g.keep_id
)
UPDATE wallet_indexing_jobs j
SET wallet_id = d.keep_id
FROM dups d
WHERE j.wallet_id = d.dup_id;

WITH groups AS (
  SELECT chain, lower(address) AS addr_lc, min(id) AS keep_id
  FROM wallets
  WHERE chain <> 'solana'
  GROUP BY chain, lower(address)
  HAVING count(*) > 1
), dups AS (
  SELECT w.id AS dup_id, g.keep_id
  FROM wallets w
  JOIN groups g
    ON w.chain = g.chain
   AND lower(w.address) = g.addr_lc
  WHERE w.id <> g.keep_id
)
UPDATE wallet_holdings_snapshots s
SET wallet_id = d.keep_id
FROM dups d
WHERE s.wallet_id = d.dup_id;

WITH groups AS (
  SELECT chain, lower(address) AS addr_lc, min(id) AS keep_id
  FROM wallets
  WHERE chain <> 'solana'
  GROUP BY chain, lower(address)
  HAVING count(*) > 1
), dups AS (
  SELECT w.id AS dup_id
  FROM wallets w
  JOIN groups g
    ON w.chain = g.chain
   AND lower(w.address) = g.addr_lc
  WHERE w.id <> g.keep_id
)
DELETE FROM wallets w
USING dups d
WHERE w.id = d.dup_id;

-- 2) Add case-insensitive uniqueness guard.
CREATE UNIQUE INDEX IF NOT EXISTS wallets_chain_address_ci_unique
  ON wallets (chain, lower(address))
  WHERE chain <> 'solana';
