# Architecture Decision: Projects vs Collections

## Current Problem

The project/collection hierarchy is causing friction:
- Collections can't exist without projects (NOT NULL constraint)
- Discovery adds collections before we know their project
- Many collections don't have a clear "parent project"
- The mapping_status field is a workaround for this mismatch

## Current Architecture

### Data Model
```
projects (1) ──< (M) collections
  ↓
collections.project_id NOT NULL (enforced relationship)
collections.mapping_status = 'unmapped' | 'mapped' (workaround)
```

### Where Projects Are Used

**1. Activity Feed**
- `activity_feed.project_id` (NOT NULL)
- Groups activity by project
- Powers project activity pages

**2. Project Pages**
- `/project/[slug]` routes
- Project overview, collections list, wiki
- Social links, verification status

**3. Discovery Features**
- `projectAffinity` table (holder overlap between projects)
- Recommendations based on project overlap
- "Discover communities" flow

**4. Wiki System**
- `project_wiki` table
- Community-editable project info

**5. User Relationships**
- `project_owners` table (founders/team)
- Ownership claims, verification

**6. URLs & Navigation**
- `/project/[slug]/[collection]` routes
- Breadcrumbs: Project → Collection
- SEO structure

## Option 1: Eliminate Projects (User's Proposal)

### New Model
```
collections (standalone)
  ↓
collection_relationships (many-to-many)
  - collection_a_id
  - collection_b_id
  - relationship_type: 'sibling' | 'successor' | 'related'
```

### Changes Required

**TABLES TO MODIFY:**
- Drop `projects` table
- Drop `project_owners`, `project_wiki`, `projectAffinity`
- Make `activity_feed.project_id` nullable or reference collection_id
- Add `collection_relationships` table
- Add `collection_metadata` (social links, description, etc.)

**FEATURES TO REDESIGN:**

1. **Collection Pages** (replace project pages)
   - `/collection/[chain]/[contract]` becomes primary
   - Collection overview, related collections, activity
   - Wiki attached to collection, not project

2. **Related Collections** (replace project hierarchy)
   - Manually curate relationships
   - Or auto-detect via holder overlap
   - Display as "Related Collections" tab

3. **Discovery**
   - Calculate `collection_affinity` (not project)
   - Recommendations based on collection overlap
   - Network graph already works at collection level

4. **Activity Feed**
   - Per-collection activity (not project)
   - Or aggregate across related collections

5. **Ownership & Verification**
   - Verify collections individually
   - Or verify "collection groups" (optional)

### Pros
✓ Simpler data model (one entity, not two)
✓ No unmapped/mapped states
✓ Collections can exist independently
✓ More flexible relationships (many-to-many)
✓ No project_id constraint issues
✓ Easier to handle multi-chain collections

### Cons
✗ Large migration effort (rewrite many features)
✗ Breaking change for existing URLs
✗ Lose concept of "official project" grouping
✗ Activity feed less cohesive (split per collection)
✗ Verification harder (verify each collection vs. one project)
✗ SEO impact (existing /project/ URLs break)

## Option 2: Make Projects Optional (Pragmatic)

### Modified Model
```
projects (optional grouping)
  ↓
collections.project_id (NULLABLE)
collections.mapping_status → DELETE (no longer needed)

+ collection_relationships (many-to-many)
  - Complements project hierarchy
  - Allows cross-project relationships
```

### Changes Required

**MINIMAL DATABASE CHANGES:**
- Make `project_id` nullable (migration 0016 - already written)
- Make `activity_feed.project_id` nullable
- Add `collection_relationships` table (optional)
- Drop `mapping_status` field (no longer needed)

**FEATURE ADJUSTMENTS:**

1. **Collections Without Projects**
   - Can exist independently
   - Show on collection page without project context
   - Discovery works (network graph doesn't need projects)

2. **Collections With Projects**
   - Grouped under project page
   - Activity aggregated at project level
   - Breadcrumbs: Project → Collection

3. **Related Collections**
   - If same project → show siblings
   - If different/no project → show via relationships or overlap
   - Network graph handles both

4. **Activity Feed**
   - If collection has project → post to project feed
   - If no project → collection-only feed
   - Both work

### Pros
✓ Minimal migration (one ALTER TABLE done)
✓ Existing features keep working
✓ Collections can exist without projects
✓ Projects still useful for official grouping
✓ Backward compatible (URLs don't break)
✓ Gradual transition (add relationships later)

### Cons
✗ Still have projects table (more complexity)
✗ Two ways to relate collections (project + relationships)
✗ Optional relationships are harder to reason about

## Option 3: Projects as Tags/Groups (Middle Ground)

### Model
```
collections (primary entity)
  ↓
collection_groups (optional)
  - group_id (UUID)
  - group_name (e.g., "Bored Ape Ecosystem")
  - group_slug
  
collection_group_membership (many-to-many)
  - collection_id
  - group_id
  - role: 'primary' | 'related' | 'spinoff'
```

### Concept
- Collections are independent
- "Projects" become optional **groups** (not parents)
- A collection can be in multiple groups
- Groups have pages like projects, but less rigid

### Example
```
Collection: Bored Ape Yacht Club #1234
  ├─ In group: "Bored Ape Ecosystem"
  └─ In group: "Blue Chip NFTs"

Collection: Mutant Ape Yacht Club #5678
  └─ In group: "Bored Ape Ecosystem"
```

### Pros
✓ Flexible (collections can be in 0-N groups)
✓ Collections independent
✓ Groups optional (not required)
✓ Can model real-world relationships better

### Cons
✗ Major refactor (rename everything project → group)
✗ Conceptually different from current model
✗ URLs break (/project/ → /group/)

## Recommendation: Option 2 (Make Projects Optional)

**Why:**
1. **Minimal Migration** - We're 80% there (migration written, just needs to run)
2. **Backward Compatible** - Existing features keep working
3. **Solves Immediate Problem** - Collections can exist without projects
4. **Low Risk** - Changes are additive, not destructive
5. **Future Flexible** - Can add collection_relationships later

**Implementation Plan:**

### Phase 1: Make Projects Optional (NOW)
1. ✅ Migration 0016 written (ALTER TABLE collections ALTER COLUMN project_id DROP NOT NULL)
2. Run migration on production
3. Make activity_feed.project_id nullable
4. Update code to handle null project_id (mostly done)
5. Test discovery with unmapped collections

### Phase 2: Collection Relationships (LATER)
1. Add collection_relationships table
2. UI to manually link related collections
3. Auto-suggest via holder overlap
4. Display in "Related Collections" tab

### Phase 3: Deprecate mapping_status (OPTIONAL)
1. All collections either have project_id or don't
2. Remove mapping_status field
3. Simplify admin UI

## Questions for Decision

1. **Do we need to group collections at all?**
   - If yes → keep projects optional
   - If no → eliminate projects entirely

2. **How important are project pages?**
   - Very → keep projects
   - Not much → collection pages suffice

3. **What about collections with multiple "siblings"?**
   - Example: BAYC, MAYC, BAKC all related
   - Projects naturally group these
   - Without projects, need relationships table

4. **Activity feed scope?**
   - Project-level (aggregate multiple collections) → need projects
   - Collection-level (per collection) → don't need projects

5. **Verification granularity?**
   - Verify "projects" (one verification for all collections) → need projects
   - Verify collections individually → don't need projects

6. **User mental model?**
   - Think in "projects that have multiple collections" → keep projects
   - Think in "collections that relate to each other" → eliminate projects

## My Take

**Keep projects, make them optional.** Here's why:

- Projects model real-world reality: BAYC *is* a project with multiple collections
- Easier verification: verify the project once, not each collection
- Better activity aggregation: see all BAYC ecosystem activity in one place
- Less disruptive: existing features keep working
- We can add collection_relationships later for edge cases

The current pain is the NOT NULL constraint, not the existence of projects. Fix that (we have), and the model works fine.

**But I'm biased toward minimal change.** If you see collections as the primary primitive and projects as legacy baggage, Option 1 might be better long-term.

## Next Steps

1. **You decide:** Option 1, 2, or 3?
2. If Option 2: I'll finish the project_id nullable migration and we're done
3. If Option 1: I'll create a migration plan for eliminating projects
4. If Option 3: I'll design the groups architecture

What do you think?
