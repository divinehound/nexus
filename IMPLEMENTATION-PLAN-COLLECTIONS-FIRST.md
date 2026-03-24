# Implementation Plan: Collections-First Architecture

## Decision: Option 2 (Make Projects Optional)

**Reality:** 80%+ of collections are standalone, not multi-collection projects.

**Goal:** Make collections work perfectly without projects. Projects become optional grouping for the 20%.

## Phase 1: Database Changes (IMMEDIATE)

### 1.1 Apply Existing Migration
```sql
-- Already written in 0016_make_project_id_nullable.sql
ALTER TABLE collections ALTER COLUMN project_id DROP NOT NULL;
```

**Action:** Run on production database NOW.

### 1.2 Make Activity Feed Optional
```sql
-- Migration 0017
ALTER TABLE activity_feed ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE activity_feed ADD COLUMN collection_id UUID REFERENCES collections(id) ON DELETE CASCADE;

-- Ensure at least one is set
ALTER TABLE activity_feed ADD CONSTRAINT activity_feed_has_project_or_collection 
  CHECK (project_id IS NOT NULL OR collection_id IS NOT NULL);
```

**Rationale:** Activity can be at project OR collection level.

### 1.3 Add Collection-Level Features
```sql
-- Migration 0018: Collection metadata (moved from projects)
ALTER TABLE collections ADD COLUMN description TEXT;
ALTER TABLE collections ADD COLUMN discord_url TEXT;
ALTER TABLE collections ADD COLUMN twitter_url TEXT;
ALTER TABLE collections ADD COLUMN website_url TEXT;
ALTER TABLE collections ADD COLUMN telegram_url TEXT;

-- Migration 0019: Collection wiki (parallel to project_wiki)
CREATE TABLE collection_wiki (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  last_edited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  last_edited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  version INTEGER DEFAULT 1,
  UNIQUE(collection_id)
);

-- Migration 0020: Collection spaces tracking
CREATE TABLE collection_spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  space_id VARCHAR(255) NOT NULL,
  title TEXT,
  scheduled_start TIMESTAMP WITH TIME ZONE,
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  host_ids TEXT[],
  speaker_ids TEXT[],
  listener_count INTEGER,
  state VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(space_id)
);

-- Add index for lookups
CREATE INDEX idx_collection_spaces_collection_id ON collection_spaces(collection_id);
CREATE INDEX idx_collection_spaces_scheduled_start ON collection_spaces(scheduled_start);
```

## Phase 2: Admin UI Redesign (PRIORITY)

### Current Problems
- Admin page assumes collections belong to projects
- Discovery adds unmapped collections → invisible in UI
- No way to manage standalone collections efficiently

### New Admin Collections Page

**Filters:**
```
[All Collections ▼] [Chain: All ▼] [Spam: Hide ▼] [Search: ___________]

Filters:
☐ Has Project
☐ No Project  
☐ Verified
☐ Unverified
☐ Indexed (holders > 0)
☐ Not Indexed

Sort: [Recently Added ▼] [Holder Count ▼] [Name A-Z ▼]
```

**Collection Card (Enhanced):**
```
┌─────────────────────────────────────────────────────┐
│ [IMG] Cool NFT Collection                    Ethereum│
│                                                       │
│ Contract: 0x1234...5678                              │
│ Holders: 1,234 | Supply: 10,000                      │
│ Project: [None] or [Linked: Project Name]           │
│                                                       │
│ Actions:                                             │
│ [Index Holders] [Discover] [Edit Details]           │
│ [Link to Project ▼] [Mark Spam] [Verify]            │
└─────────────────────────────────────────────────────┘
```

**Bulk Actions:**
```
☑ Select All (50 on page)

Selected: 12 collections
[Link to Project] [Mark Verified] [Mark Spam] [Index Holders]
```

**New: "Edit Collection Details" Modal**
- Collection name
- Description
- Social links (Twitter, Discord, Website)
- Chain + contract (read-only)
- Project assignment (optional dropdown)

### File Changes
- `apps/web/src/app/admin/collections/page.tsx` - major redesign
- Add filters, bulk actions, inline editing
- Remove assumption that collections have projects

## Phase 3: Collection Page Redesign

### Current: `/collection/[chain]/[contract]`

**Tabs (Enhanced):**
```
[Overview] [Related Collections] [Community Overlap] [Activity] [Wiki] [Spaces]
```

**Overview Tab:**
- Collection stats (holders, supply, floor price)
- Description (if set)
- Social links (Twitter, Discord, etc.)
- Project link (if mapped)
- Verification badge

**Activity Tab:**
- Sales, notable sales, whale moves
- Filter by activity type
- Aggregates collection_id activity

**Wiki Tab:**
- Editable markdown (like project wiki)
- Falls back to project wiki if collection is mapped
- Community-editable

**Spaces Tab:**
- Upcoming/past Twitter Spaces for this collection
- Schedule new Space
- Archives with recordings

### File Changes
- `apps/web/src/app/collection/[chain]/[contract]/page.tsx` - add tabs
- `apps/web/src/components/collections/collection-overview.tsx` - new component
- `apps/web/src/components/collections/collection-activity.tsx` - new component
- `apps/web/src/components/collections/collection-wiki.tsx` - new component
- `apps/web/src/components/collections/collection-spaces.tsx` - new component

## Phase 4: Backend API Changes

### New Endpoints

**Collection Details:**
```typescript
GET /collections/:id
// Returns full collection with metadata, stats, social links
// Works with or without project

PATCH /collections/:id
// Update description, social links, etc.
// Admin only
```

**Collection Wiki:**
```typescript
GET /collections/:id/wiki
POST /collections/:id/wiki
// Edit wiki content (authenticated users)
```

**Collection Activity:**
```typescript
GET /collections/:id/activity?type=sale&limit=50
// Returns activity_feed items for this collection
// Falls back to project activity if collection is mapped
```

**Collection Spaces:**
```typescript
GET /collections/:id/spaces?upcoming=true
POST /collections/:id/spaces
// Track Twitter Spaces for this collection
```

### Modified Endpoints

**GET /admin/collections:**
- Add filters: hasProject, noProject, indexed, verified
- Support bulk operations
- Return collections without projects

**POST /admin/collections/:id/link-project:**
- Link/unlink collection to project
- Nullable project_id

### File Changes
- `apps/api/src/modules/collections/collections.controller.ts` - add endpoints
- `apps/api/src/modules/collections/collections.service.ts` - add methods
- `apps/api/src/modules/admin/admin.controller.ts` - add bulk actions

## Phase 5: Spaces Integration

### Current State
- Spaces tracked at project level (`events` table)
- Discovery polls Twitter API for project-related spaces

### New State
- Spaces tracked at collection level (`collection_spaces` table)
- Spaces can be associated with collection OR project (or both)

### Changes
- Add `collection_id` to `events` table (nullable)
- Twitter Spaces cron checks both projects and collections
- Collection page shows collection-specific spaces
- Project page aggregates spaces from all collections

## Phase 6: Search & Discovery Updates

### Collection Search
- Update search to show collections without projects
- Show "Standalone Collection" badge
- Filter by hasProject/noProject

### Network Graph
- Already works at collection level ✓
- No changes needed

### Recommendations
- Already works at collection level ✓
- No changes needed

## Phase 7: SEO & URLs

### URL Strategy
```
/collection/[chain]/[contract]          # Primary (always works)
/project/[slug]/[collection]             # Redirect to primary (if project exists)
```

### Canonical URLs
- All collection pages use `/collection/` route
- Project pages link to collection via canonical URL
- Breadcrumbs: "Home > Collection Name" (no project if unmapped)

## Implementation Order

### Sprint 1: Database Foundation (1-2 days)
1. ✅ Run migration 0016 (make project_id nullable)
2. Create migrations 0017-0020 (activity_feed, collection metadata, wiki, spaces)
3. Apply to production
4. Update schema types

### Sprint 2: Admin UI (2-3 days)
1. Redesign admin collections page
2. Add filters (has/no project, verified, indexed)
3. Add bulk actions
4. Add "Edit Collection" modal
5. Test with large dataset (1000+ collections)

### Sprint 3: Collection Pages (2-3 days)
1. Add Overview tab (description, social links)
2. Add Wiki tab (collection-level wiki)
3. Add Activity tab (collection-level activity feed)
4. Add Spaces tab (collection-level spaces)
5. Test with and without project assignment

### Sprint 4: Backend APIs (1-2 days)
1. Add collection update endpoint
2. Add collection wiki endpoints
3. Add collection activity endpoint
4. Add collection spaces endpoints
5. Update admin endpoints for bulk actions

### Sprint 5: Spaces Integration (1 day)
1. Extend events table with collection_id
2. Update Twitter Spaces cron
3. Show spaces on collection pages

### Sprint 6: Polish & Migration (1 day)
1. Add "Link to Project" flow in admin
2. Migrate existing project metadata to primary collections
3. Update search to handle unmapped collections
4. SEO verification

## Success Metrics

**Before:**
- Collections without projects: 0 (blocked by constraint)
- Admin workflow: Project → Collections
- Discovery results: Invisible (unmapped)

**After:**
- Collections without projects: 80%+ supported
- Admin workflow: Collections → Optionally group into project
- Discovery results: All collections visible
- Collection pages: Fully featured (wiki, spaces, activity)

## Migration Path for Existing Data

1. Run migrations to add nullable columns
2. Existing collections keep project_id (no data loss)
3. New collections can omit project_id
4. Gradually populate collection metadata for standalone collections
5. Project pages still work (aggregate from mapped collections)

## Rollback Plan

If things go wrong:
1. Migrations are additive (no DROP)
2. Can restore project_id NOT NULL constraint
3. Collections without projects become hidden again
4. Revert UI changes via git

## Questions & Edge Cases

**Q: What if a collection is in multiple projects?**
A: Not supported in this design. Use collection_relationships later if needed.

**Q: What about project-level features (verification, ownership)?**
A: Keep for projects. Add collection-level equivalents where needed.

**Q: Activity feed for collections without projects?**
A: Store with collection_id, no project_id. Show on collection page.

**Q: Search results for unmapped collections?**
A: Show as "Standalone Collection" with chain badge.

**Q: How to convert a standalone collection to project?**
A: Admin sets project_id. Data stays, just gains project association.

## Timeline

**Total: 8-12 days of focused work**

- Database: 1-2 days
- Admin UI: 2-3 days
- Collection Pages: 2-3 days
- Backend APIs: 1-2 days
- Spaces: 1 day
- Polish: 1 day

Can be parallelized or done incrementally.

## Next Actions

1. **User approval** on this plan
2. **Run migration 0016** on production (unblocks discovery)
3. **Create remaining migrations** (0017-0020)
4. **Start with Admin UI** (biggest user-facing impact)
5. **Roll out collection features** incrementally

Ready to proceed?
