## Spam Management System

Comprehensive approach to handling spam NFT collections (airdrops, vouchers, phishing, etc.)

## Problem

After indexing holders, collections contain spam:
- Airdrop scams ("Free $10,000 USDT!")
- Vouchers and promotions
- Phishing attempts
- Low-quality free mints

These pollute:
- User portfolios
- Collection discovery
- Related collections analysis
- Search results

## Solution: Multi-Layer Detection + Community Reporting

### Layer 1: Automatic Detection (Indexing Time)

**Alchemy API provides spam flags:**
```javascript
// During holder indexing
const response = await alchemy.getOwnersForContract(contract);
if (response.isSpam || response.spamScore > 80) {
  markAsSpam(collection, 'alchemy', response.spamScore);
}
```

**Helius API for Solana:**
```javascript
// Similar spam detection
if (asset.burnt || asset.compression?.compressed === false) {
  // Potential spam indicators
}
```

### Layer 2: Manual Admin Review

**Admin Collections Page:**
- Show spam badge on flagged collections
- "Mark as Spam" button
- "Not Spam" button (for false positives)
- Bulk actions: "Hide all spam"

### Layer 3: Community Reporting

**User-Facing:**
- "Report Spam" button on collection pages
- Report reasons: airdrop, phishing, low_quality, other
- Threshold: 5 reports → auto-flag for admin review
- "This is legitimate" counter-reports

### Layer 4: Allowlist

**For False Positives:**
- Admin can add to spam_allowlist
- Overrides automatic detection
- Shows "Verified Not Spam" badge

## Database Schema

### collections table (new fields)
```sql
is_spam BOOLEAN DEFAULT FALSE
spam_score INTEGER (0-100)
spam_reason TEXT (airdrop, phishing, free_mint, etc)
spam_detected_at TIMESTAMP
spam_detected_by ENUM (alchemy, helius, manual, community)
```

### spam_reports table
```sql
collection_id
reported_by_user_id
report_type ENUM (spam, not_spam)
reason TEXT
notes TEXT
created_at
```

### spam_allowlist table
```sql
collection_id (unique)
added_by_user_id
reason TEXT
created_at
```

## Workflows

### Workflow 1: Automatic Detection

```
1. Index holders via Alchemy/Helius
2. API returns spam flags
3. If spam_score > 80:
   - Set is_spam = true
   - Set spam_detected_by = 'alchemy' or 'helius'
   - Set spam_reason from API
4. Collection hidden from default views
```

### Workflow 2: Admin Manual Review

```
1. Admin views collections (filter: "Flagged as Spam")
2. Reviews collection details
3. Clicks "Confirm Spam" or "Not Spam"
   - Confirm: is_spam = true, spam_detected_by = 'manual'
   - Not Spam: Add to spam_allowlist
4. Bulk action: "Hide all auto-detected spam"
```

### Workflow 3: User Report

```
1. User sees spam in their portfolio
2. Clicks "Report Spam" on collection page
3. Selects reason, adds notes (optional)
4. Report saved to spam_reports
5. If 5+ spam reports and no counter-reports:
   - Flag for admin review
   - Show warning badge
6. If admin confirms: is_spam = true, spam_detected_by = 'community'
```

### Workflow 4: False Positive

```
1. Legitimate collection flagged as spam
2. Admin clicks "Not Spam"
3. Added to spam_allowlist
4. is_spam = false
5. Shows "Verified" badge
6. Never auto-flagged again
```

## UI Components

### Admin Collections Page
- **Filter:** "Show Spam" / "Hide Spam" / "Spam Only"
- **Badge:** 🚫 Spam (score: 85) - Alchemy
- **Actions:**
  - Mark as Spam
  - Not Spam (Add to Allowlist)
  - Bulk: Hide All Spam

### Collection Detail Page (Public)
- **If is_spam = true:**
  - Warning banner: "⚠️ This collection may be spam"
  - Hidden from Related Collections
  - Hidden from search results
  - Hidden from user portfolios (with "show spam" toggle)

- **Report Button:**
  - "Report Spam" (if not already spam)
  - "This is Legitimate" (if flagged as spam)

### User Portfolio Page
- **Default:** Hide spam collections
- **Toggle:** "Show X hidden spam collections"
- **Individual:** "Hide from portfolio" button

## API Endpoints

```typescript
// Admin
POST /admin/collections/:id/mark-spam
POST /admin/collections/:id/mark-not-spam
POST /admin/collections/bulk-hide-spam

// User
POST /api/collections/:id/report-spam
POST /api/collections/:id/report-not-spam
GET /api/me/portfolio?includeSpam=false
```

## Filtering Rules

### Hidden By Default:
- Related Collections feature
- Search results
- Discovery page
- User portfolios
- Activity feeds

### Still Visible:
- Direct collection URL (with warning)
- Admin collections page
- User portfolio (with "show spam" toggle)
- Search by exact contract address

## Spam Score Calculation

```
Automatic (Alchemy/Helius):
- API provides score 0-100
- > 80 = auto-hide
- 50-80 = warning, needs review
- < 50 = likely legitimate

Community (Report-based):
- Each spam report +10
- Each "not spam" report -15
- 5+ net spam reports = flagged
- Admin confirmation = permanent

Manual (Admin):
- is_spam = true (definitive)
- spam_score = 100
```

## Implementation Phases

**Phase 1 (This PR):**
- ✅ Database schema
- ✅ Migration

**Phase 2 (Next):**
- Integrate Alchemy spam flags during indexing
- Update holder indexer to check spam scores
- Auto-flag high-confidence spam

**Phase 3:**
- Admin UI: spam badges, mark/unmark buttons
- Spam filter on admin collections page
- Bulk hide spam action

**Phase 4:**
- User-facing report spam feature
- "Show spam" toggle on portfolios
- Community reporting thresholds

**Phase 5:**
- Spam allowlist management
- False positive handling
- "Verified Not Spam" badges

## Testing Strategy

1. Index a known spam collection
2. Verify is_spam flag set automatically
3. Check it's hidden from Related Collections
4. Admin marks as "Not Spam"
5. Verify added to allowlist
6. User reports legitimate collection as spam
7. Verify needs 5 reports before flagging
8. Admin confirms spam
9. Verify permanently flagged

## Metrics to Track

- Total collections marked as spam
- Spam reports per day
- False positive rate
- Collections on allowlist
- User-reported spam conversion rate
