# Collection Holder Snapshots

## Overview

Historical tracking of collection holders to enable:
- Community growth analytics
- Holder retention analysis  
- Timeline features ("joined 30 days ago")
- Churn detection

## Tables

### `collection_holder_history`
Daily snapshots of individual holder token counts.

**Columns:**
- `collection_id` - which collection
- `address` - wallet address
- `token_count` - tokens held that day
- `snapshot_date` - the date of this snapshot
- `event_type` - join | increase | decrease | exit
- `created_at` - when snapshot was recorded

**Use cases:**
- "Show me who joined in the last week"
- "Track holder retention over 30 days"
- "When did this wallet first hold this collection?"

### `collection_daily_metrics`
Aggregate metrics per collection per day.

**Columns:**
- `collection_id`
- `metric_date`
- `holder_count` - total holders that day
- `new_holders` - joined that day
- `exited_holders` - left that day
- `total_tokens_held` - sum of all tokens
- `avg_tokens_per_holder` - average holding size

**Use cases:**
- Growth charts on collection pages
- "Collections trending up/down this week"
- Community health scoring

## Snapshot Flow

### Daily Job (Not Yet Scheduled)

```typescript
// Run nightly at 00:00 UTC
await holderSnapshotService.createAllSnapshots(new Date());
```

**For each fully-indexed collection:**
1. Compare today's `collection_holders` vs yesterday's snapshot
2. Detect changes:
   - New addresses → `event_type: 'join'`
   - Increased count → `event_type: 'increase'`  
   - Decreased count → `event_type: 'decrease'`
   - Missing addresses → `event_type: 'exit'`
3. Write to `collection_holder_history`
4. Aggregate metrics → `collection_daily_metrics`

## Queries

### Recent Joins
```sql
SELECT address, token_count, snapshot_date
FROM collection_holder_history
WHERE collection_id = :id
  AND event_type = 'join'
  AND snapshot_date > NOW() - INTERVAL '7 days'
ORDER BY snapshot_date DESC;
```

### 30-Day Retention
```sql
WITH baseline AS (
  SELECT DISTINCT address
  FROM collection_holder_history
  WHERE collection_id = :id
    AND snapshot_date = :date_30_days_ago
),
current AS (
  SELECT address 
  FROM collection_holders
  WHERE collection_id = :id
)
SELECT 
  COUNT(DISTINCT baseline.address) as original_holders,
  COUNT(DISTINCT current.address) as still_holding,
  ROUND(COUNT(DISTINCT current.address) * 100.0 / COUNT(DISTINCT baseline.address), 2) as retention_pct
FROM baseline
LEFT JOIN current USING (address);
```

### Growth Trend
```sql
SELECT 
  metric_date,
  holder_count,
  new_holders,
  exited_holders,
  (new_holders - exited_holders) as net_change
FROM collection_daily_metrics
WHERE collection_id = :id
ORDER BY metric_date DESC
LIMIT 30;
```

## Next Steps

1. **Schedule daily snapshots** (cron job or manual trigger)
2. **Backfill initial snapshot** after indexing a collection
3. **Add growth charts** to collection detail pages
4. **Build retention API** for analytics queries
5. **Community health scoring** based on growth + retention

## Storage Estimates

**100 collections × 365 days:**
- Daily metrics: 36,500 rows (~5MB)
- Holder history (avg 5K holders): 182M rows (~30GB annually)

**Optimization:**
- Partition `collection_holder_history` by `snapshot_date` (monthly)
- Archive old snapshots to cold storage
- Only store changes (not full snapshots for unchanged holders)

## Manual Snapshot (For Testing)

```typescript
// In admin controller or script
const result = await holderSnapshotService.createDailySnapshot(
  'collection-id-here',
  new Date()
);

console.log(`Joins: ${result.joins}, Exits: ${result.exits}`);
```
