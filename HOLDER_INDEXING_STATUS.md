# Holder Indexing Status

## Issue: Solana Deads shows 0 overlap

**Collection:** Solana Deads (7ZYBDpPou8EehaYz6nUPExy5DU1bL3E64P5AKtikwZnh)
**Problem:** Community Overlap tab shows 0 connections
**Root Cause:** Collection has not been indexed for holders yet

## How Holder Indexing Works

1. Collection is added to database (metadata only)
2. **Holder indexing must be triggered manually** from admin panel
3. System fetches all holders via Alchemy (EVM) or Helius (Solana)
4. Holders stored in `collection_holders` table
5. Overlap calculations use `collection_holders` data

## To Fix Solana Deads

**Admin Panel → Collections:**
1. Find "Solana Deads"
2. Click "Index Holders" button
3. Wait for indexing to complete (~1-5 minutes)
4. Refresh collection page
5. Community Overlap tab will now show connections

## Checking Index Status

**SQL Query:**
```sql
SELECT 
  c.name,
  c.chain,
  c.holder_count,
  c.last_index_finished_at,
  c.last_index_status,
  COUNT(ch.address) as indexed_holders_in_table
FROM collections c
LEFT JOIN collection_holders ch ON ch.collection_id = c.id
WHERE c.contract_address = '7ZYBDpPou8EehaYz6nUPExy5DU1bL3E64P5AKtikwZnh'
GROUP BY c.id;
```

Expected after indexing:
- `holder_count`: ~500-2000 (actual number)
- `indexed_holders_in_table`: matches holder_count
- `last_index_status`: 'success'
- `last_index_finished_at`: recent timestamp

## Bulk Indexing

To index all collections at once:
1. Admin panel → Collections
2. Filter to non-spam collections
3. Select all (or specific collections)
4. Click "Bulk Index Holders" button
5. Wait for completion (background job)

## API Endpoint

Manual trigger via API:
```
POST /admin/collections/{collectionId}/index-holders
Authorization: Bearer {admin-token}
```

Returns:
```json
{
  "success": true,
  "holdersIndexed": 1234
}
```
