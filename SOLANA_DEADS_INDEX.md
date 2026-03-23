# How to Index Solana Deads

**Collection:** Solana Deads  
**Contract:** `7ZYBDpPou8EehaYz6nUPExy5DU1bL3E64P5AKtikwZnh`  
**Chain:** Solana

## Problem

The collection doesn't appear in the admin collections page because it may not be mapped to a project yet.

## Solution: Direct API Call

Use the API directly to trigger holder indexing:

```bash
# Get collection ID first
curl 'https://nexus-dev.intentionworks.xyz/api/collections/solana/7ZYBDpPou8EehaYz6nUPExy5DU1bL3E64P5AKtikwZnh' \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN'

# Response will include: { "id": "collection-uuid", ... }

# Then trigger indexing
curl -X POST 'https://nexus-dev.intentionworks.xyz/api/admin/collections/{collection-uuid}/index-holders' \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'Content-Type: application/json'
```

## Alternative: Database Query

Connect to the database and run:

```sql
-- Get collection ID
SELECT id, name, holder_count, last_index_status, last_index_finished_at
FROM collections
WHERE contract_address = '7ZYBDpPou8EehaYz6nUPExy5DU1bL3E64P5AKtikwZnh'
  AND chain = 'solana';

-- Note the collection ID, then trigger via API
```

## Why It's Not in Admin Page

The admin collections page loads via `/admin/projects` endpoint, which only returns collections that are mapped to projects. Collections without a project mapping won't appear.

## Recommendation

Add to admin page:
1. "Search by Contract Address" field
2. Direct collection lookup endpoint
3. Ability to index collections not yet mapped to projects
