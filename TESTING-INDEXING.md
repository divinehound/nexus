# Testing Full Holder Indexing

## Prerequisites

1. ✅ Migrations applied (`0012_add_collection_index_status.sql` + `0013_add_collection_holders.sql`)
2. ✅ API running with new code deployed
3. ✅ Admin account with JWT token

## Manual Test Steps

### Option A: Via Browser (Easiest)

1. **Log in** to https://nexus.dev.intentionworks.xyz as admin
2. **Open DevTools** → Network tab
3. **Navigate** to any page that makes an API call
4. **Copy your JWT token** from the `Authorization` header
5. **Run this curl command**:

```bash
COLLECTION_ID="27bc7ef8-c988-4583-af56-c2253567ebf0"  # Bored Ape
JWT_TOKEN="<your-token-here>"

curl -X POST "https://api.nexus.dev.intentionworks.xyz/admin/collections/$COLLECTION_ID/index-holders" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json"
```

### Option B: Direct Database Query (Check if it worked)

After running the indexing:

```bash
PGPASSWORD='qHbBhmwYUdlHrXiaYIxXM-qL' psql -h localhost -p 5432 -U nexus_app -d nexus_dev -c "
SELECT 
  COUNT(*) as holder_count,
  c.name as collection_name
FROM collection_holders ch
JOIN collections c ON ch.collection_id = c.id
WHERE ch.collection_id = '27bc7ef8-c988-4583-af56-c2253567ebf0'
GROUP BY c.name;
"
```

### Option C: Check Related Collections UI

1. Visit a collection detail page
2. Scroll to "Related Collections" section
3. Should see collections with overlapping holders

## Expected Flow

1. **POST /admin/collections/:id/index-holders**
2. Service fetches ALL holders from Alchemy API
3. Stores in `collection_holders` table
4. Updates `collections.holder_count`
5. Returns: `{ success: true, holdersIndexed: 10000, collection: "BoredApeYachtClub" }`

## Verified Collections Available for Testing

```sql
SELECT id, name, chain FROM collections 
WHERE verification_status = 'verified' 
ORDER BY name;
```

| Name | Chain | ID |
|------|-------|-----|
| AncientBatz | ethereum | 67557e7f-ed78-4f10-860c-a86584c5af59 |
| BEARISH | abstract | 99fb610b-bb9c-4a79-a5f1-ee122fabfc09 |
| BoredApeYachtClub | ethereum | 27bc7ef8-c988-4583-af56-c2253567ebf0 |
| BullBears | solana | bf408928-4ae4-4a3f-a359-de8574126543 |
| Claynosaurz | solana | 63fa265f-2ab5-49ef-8f76-89f7de02e184 |

## What to Watch

- **API logs**: `docker logs -f <nexus-api-container-id>`
- **Progress**: Should log every 100 holders
- **Errors**: Alchemy rate limits, network issues
- **Completion**: "Completed indexing N holders"

## Troubleshooting

**"Alchemy API key not configured"**
- Check env var `ALCHEMY_API_KEY` in API container

**"Solana indexing not yet supported"**
- Only EVM chains (Ethereum, Base, Polygon, Abstract) work currently
- Solana needs Helius integration

**Rate limits (429)**
- Alchemy free tier: 300 requests/second
- Large collections (10K+ holders) may hit limits
- Retry after cooldown period
