-- Clean up fake collections created by mock wallet indexing
-- These have invalid/truncated contract addresses

BEGIN;

-- Delete wallet holdings snapshots for invalid addresses
DELETE FROM wallet_holdings_snapshots
WHERE chain <> 'solana' 
  AND (
    length(contract_address) <> 42 
    OR contract_address !~ '^0x[a-f0-9]{40}$'
  );

-- Delete collections with invalid addresses
WITH invalid_collections AS (
  SELECT id
  FROM collections
  WHERE chain <> 'solana'
    AND (
      length(contract_address) <> 42
      OR contract_address !~ '^0x[a-f0-9]{40}$'
    )
)
DELETE FROM collections
WHERE id IN (SELECT id FROM invalid_collections);

-- Delete auto-generated projects that no longer have any collections
WITH orphaned_projects AS (
  SELECT p.id
  FROM projects p
  WHERE p.name LIKE 'Auto %'
    AND NOT EXISTS (
      SELECT 1 FROM collections c WHERE c.project_id = p.id
    )
)
DELETE FROM projects
WHERE id IN (SELECT id FROM orphaned_projects);

COMMIT;

-- Report what was cleaned
SELECT 
  'Cleanup complete' AS status,
  (SELECT count(*) FROM collections WHERE chain <> 'solana' AND (length(contract_address) <> 42 OR contract_address !~ '^0x[a-f0-9]{40}$')) AS remaining_invalid_collections,
  (SELECT count(*) FROM projects WHERE name LIKE 'Auto %') AS remaining_auto_projects;
