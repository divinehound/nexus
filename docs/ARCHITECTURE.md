# NEXUS — Architecture & Codebase Documentation

Comprehensive technical reference for the NEXUS platform. Covers repository structure, all services, business rules, data flows, and operational details.

---

## Table of Contents

1. [Repository Structure](#repository-structure)
2. [Technology Stack](#technology-stack)
3. [Database Schema](#database-schema)
4. [Authentication & Authorization](#authentication--authorization)
5. [API Modules](#api-modules)
6. [Business Rules & Domain Logic](#business-rules--domain-logic)
7. [Cron Jobs & Background Workers](#cron-jobs--background-workers)
8. [Webhook Ingestion Pipeline](#webhook-ingestion-pipeline)
9. [Frontend Architecture](#frontend-architecture)
10. [Configuration & Environment](#configuration--environment)
11. [Deployment](#deployment)
12. [API Route Reference](#api-route-reference)

---

## Repository Structure

```
nexus/
├── apps/
│   ├── api/                  # NestJS 11 backend (port 4000)
│   │   ├── src/
│   │   │   ├── common/       # Shared guards, database module
│   │   │   ├── config/       # App configuration, env validation
│   │   │   ├── modules/      # Feature modules (12 total)
│   │   │   ├── app.module.ts # Root module
│   │   │   └── main.ts       # Bootstrap
│   │   └── jest.config.ts
│   └── web/                  # Next.js 16 frontend (port 3000)
│       ├── src/
│       │   ├── app/          # App Router pages & API routes
│       │   ├── components/   # React components
│       │   ├── context/      # Auth & provider context
│       │   └── lib/          # API client, utilities, wagmi config
│       └── next.config.ts
├── packages/
│   ├── database/             # Drizzle ORM schema & client
│   │   ├── src/schema/       # 9 schema files, 15 tables
│   │   ├── src/client.ts     # Database connection factory
│   │   ├── src/migrate.ts    # Migration runner
│   │   ├── src/seed.ts       # Seed script
│   │   └── drizzle/          # SQL migrations
│   ├── types/                # Shared TypeScript interfaces & enums
│   └── eslint-config/        # Shared linting rules
├── Dockerfile                # Multi-stage (api + web targets)
├── docker-compose.yml        # Postgres + API + Web
└── .github/workflows/ci.yml  # Lint → Test → Build → Docker
```

### Workspace Packages

| Package | Name | Purpose |
|---------|------|---------|
| `packages/database` | `@nexus/database` | Drizzle schema, client, migrations, seed |
| `packages/types` | `@nexus/types` | Shared enums and interfaces |
| `packages/eslint-config` | `@nexus/eslint-config` | Shared ESLint rules |
| `apps/api` | `@nexus/api` | NestJS REST API |
| `apps/web` | `@nexus/web` | Next.js frontend |

---

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | 22 |
| Package manager | pnpm | 10.29 |
| Monorepo | Turborepo | 2.x |
| Backend framework | NestJS | 11 |
| Frontend framework | Next.js (App Router) | 16 |
| UI | React + Tailwind CSS | 19 / 4 |
| Database | PostgreSQL | 16 |
| ORM | Drizzle ORM | 0.39 |
| Auth | SIWE + JWT (Passport) | — |
| EVM wallets | RainbowKit + wagmi + viem | 2.x |
| Base Smart Wallet | Coinbase Wallet SDK (via RainbowKit) | — |
| Abstract Global Wallet | @abstract-foundation/agw-react | 2.x |
| Solana wallets | @solana/wallet-adapter | 0.15 |
| Cron | @nestjs/schedule | 5 |
| Rate limiting | @nestjs/throttler | 6 |
| API docs | Swagger (@nestjs/swagger) | 11 |
| Validation | class-validator + class-transformer | 0.14 / 0.5 |

---

## Database Schema

### Enums

| Enum | Values | Used by |
|------|--------|---------|
| `chain` | `ethereum`, `base`, `abstract`, `apechain`, `polygon`, `solana` | collections, wallets, holders |
| `collection_type` | `erc721`, `erc1155`, `spl` | collections |
| `user_role` | `user`, `admin` | users |
| `event_type` | `spaces`, `ama`, `mint`, `collab`, `irl`, `other` | events |
| `event_status` | `upcoming`, `live`, `ended` | events |
| `event_source` | `auto_twitter`, `manual`, `on_chain` | events |
| `activity_type` | `sale`, `notable_sale`, `whale_move`, `milestone`, `flex` | activity_feed |
| `wiki_suggestion_status` | `pending`, `approved`, `rejected` | wiki_suggestions |
| `project_owner_role` | `owner`, `editor` | project_owners |

### Tables

#### Core Entities

**`projects`** — NFT project / community
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | auto-generated |
| name | varchar(255) | required |
| slug | varchar(255) | unique, used in URLs |
| description | text | |
| image_url, banner_url | text | |
| website_url, twitter_url, discord_url, telegram_url | text | social links |
| twitter_id | varchar(255) | Twitter user ID for Spaces polling |
| deployer_addresses | text[] | on-chain deployer wallets |
| health_score | integer | 0–100, computed by cron |
| cluster_id | uuid | community cluster assignment |
| is_verified | boolean | admin-toggled |
| created_at | timestamptz | |

**`collections`** — Individual NFT contracts belonging to a project
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| project_id | uuid FK → projects | cascade delete |
| contract_address | varchar(255) | |
| chain | enum | ethereum or solana |
| name | varchar(255) | |
| supply, holder_count, listed_count | integer | |
| floor_price | real | in native token (ETH/SOL) |
| mint_date | timestamptz | |
| collection_type | enum | erc721, erc1155, spl |

#### Users & Identity

**`users`** — Platform users (wallet-based identity)
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| primary_wallet_id | uuid | self-referencing |
| role | enum | `user` or `admin` |
| echo_score | integer | cached echo chamber score |
| cluster_ids | uuid[] | community clusters |
| created_at, last_active_at | timestamptz | |

**`wallets`** — Connected wallets (users can have multiple)
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| address | varchar(255) | |
| chain | enum | |
| user_id | uuid FK → users | set null on delete |
| ens_name, sns_name | varchar(255) | resolved names |
| last_synced_at | timestamptz | |

**`holders`** — NFT ownership records (synced via webhooks)
| Column | Type | Notes |
|--------|------|-------|
| wallet_address | varchar(255) | |
| collection_id | uuid | |
| chain | enum | |
| quantity | integer | default 1 |
| is_current | boolean | false = sold/transferred out |
| first_acquired_at | timestamptz | |

#### Content

**`events`** — Twitter Spaces, AMAs, mints, collabs, IRL events
| Column | Type | Notes |
|--------|------|-------|
| project_id | uuid FK → projects | cascade delete |
| title | varchar(500) | |
| event_type | enum | spaces, ama, mint, collab, irl, other |
| start_time, end_time | timestamptz | |
| source | enum | auto_twitter, manual, on_chain |
| twitter_space_id | varchar(255) | for deduplication |
| status | enum | upcoming, live, ended |
| submitted_by | uuid FK → users | null for auto-detected |

**`activity_feed`** — Sales, whale moves, flexes
| Column | Type | Notes |
|--------|------|-------|
| project_id | uuid FK → projects | |
| activity_type | enum | sale, notable_sale, whale_move, milestone, flex |
| wallet_address | varchar(255) | |
| collection_id | uuid FK → collections | |
| token_id | varchar(255) | |
| price | real | in native token |
| message, image_url | text | flex-specific content |

**`flex_reactions`** — Reactions to activity items
| Column | Type | Notes |
|--------|------|-------|
| activity_id | uuid FK → activity_feed | cascade delete |
| wallet_address | varchar(255) | one reaction per wallet |

**`project_wiki`** — Community-editable project documentation
| Column | Type | Notes |
|--------|------|-------|
| project_id | uuid FK → projects | unique (one wiki per project) |
| description_md | text | markdown content |
| auto_timeline | jsonb | auto-generated timeline |
| revision_number | integer | incremented on edit |
| last_edited_by | uuid FK → users | |

**`wiki_suggestions`** — Proposed wiki edits (moderation queue)
| Column | Type | Notes |
|--------|------|-------|
| project_id | uuid FK → projects | |
| submitted_by | uuid FK → users | cascade delete |
| field | text | which wiki field to update |
| proposed_value | text | new content |
| status | enum | pending → approved or rejected |

#### Market Data

**`market_snapshots`** — Time-series market data per collection
| Column | Type | Notes |
|--------|------|-------|
| collection_id | uuid FK → collections | cascade delete |
| timestamp | timestamptz | |
| floor_price, volume_24h | real | |
| holder_count, listed_count | integer | |

#### Discovery & Affinity

**`project_affinity`** — Holder overlap between two projects
- `project_a_id`, `project_b_id`, `overlap_count`, `overlap_pct`

**`collection_affinity`** — Holder overlap between two collections
- `collection_a_id`, `collection_b_id`, `overlap_count`, `overlap_pct`

**`wallet_affinity`** — Similarity between two wallets
- `wallet_a_id`, `wallet_b_id`, `shared_projects`, `affinity_score`

**`clusters`** — Community groupings
- `id`, `name`, `color` (hex), `project_count`, `holder_count`

#### Access Control

**`project_owners`** — Maps users to projects with roles
| Column | Type | Notes |
|--------|------|-------|
| project_id | uuid FK → projects | cascade delete |
| user_id | uuid FK → users | cascade delete |
| role | enum | `owner` or `editor` |

### Relations (Drizzle)

```
projects ──1:N──→ collections
projects ──1:1──→ project_wiki
projects ──1:N──→ events
projects ──1:N──→ activity_feed
projects ──1:N──→ project_owners
collections ──1:N──→ market_snapshots
users ──1:N──→ wallets
users ──1:N──→ wiki_suggestions
users ──1:N──→ project_owners
activity_feed ──1:N──→ flex_reactions
collections ←──N:1── activity_feed
```

---

## Authentication & Authorization

### Auth Flow (Wallet-based, no passwords)

```
1. Client requests nonce:    POST /api/auth/nonce { address }
2. Server generates nonce:   Stored in memory with 5-minute TTL
3. Client signs message:     SIWE (EVM) or custom message (Solana)
4. Client submits signature: POST /api/auth/verify/evm or /verify/solana
5. Server verifies:          SIWE library (EVM) or nacl.verify (Solana)
6. Server issues tokens:     { accessToken (default expiry), refreshToken (30 days) }
7. Client stores tokens:     localStorage under 'nexus_auth'
8. Subsequent requests:      Authorization: Bearer <accessToken>
9. Token refresh:            POST /api/auth/refresh { refreshToken }
```

### JWT Payload

```json
{ "sub": "<userId>", "address": "<walletAddress>", "role": "user|admin" }
```

### EVM Authentication (SIWE)

- Uses the `siwe` library (`SiweMessage.verify`)
- Nonce must match the one generated for that address
- On success, finds or creates user + wallet records
- Updates `last_active_at` on every login

### Solana Authentication

- Custom message format: `"Sign this message to authenticate with NEXUS.\n\nNonce: <nonce>"`
- Verified using `tweetnacl` (`nacl.sign.detached.verify`)
- Public key decoded from base58 (`bs58`)

### User Provisioning

On first login (either chain):
1. Check if wallet address exists in `wallets` table
2. If wallet exists and has a `userId`, return that user
3. Otherwise, create new `users` row + new `wallets` row
4. Set `primary_wallet_id` to the newly created wallet

### Guards

| Guard | Location | Purpose |
|-------|----------|---------|
| `AuthGuard('jwt')` | Passport JWT strategy | Protects authenticated endpoints |
| `AdminGuard` | `common/guards/admin.guard.ts` | Extends JWT guard, checks `role === 'admin'` |
| `ThrottlerGuard` | Global (APP_GUARD) | Rate limiting: 60 req/min per IP |

### Role-Based Access Control

| Role | Capabilities |
|------|-------------|
| `user` | Post flexes, react to activity, submit events, suggest wiki edits, view personalized discovery |
| `admin` | All user capabilities + admin panel: verify/delete projects, approve/reject wiki edits, manage events, promote/demote users, manage project ownership |

---

## API Modules

### auth (`/api/auth`)
- Nonce generation with 5-minute TTL (in-memory Map)
- SIWE verification for Ethereum wallets
- Ed25519 verification for Solana wallets
- JWT issuance (access + refresh tokens)
- User profile retrieval with linked wallets

### projects (`/api/projects`)
- List all projects with pagination (includes collections)
- Trending projects: top 10 by `health_score DESC`
- Project detail by slug (includes collections, wiki, events)
- Community overlap: top 10 related projects by holder overlap percentage

### collections (`/api/collections`)
- Lookup by UUID or contract address
- Returns collection with project parent and market snapshot history

### activity (`/api/projects/:projectId/activity`)
- Paginated activity feed per project (default 20 per page, newest first)
- Flex posting: creates `activity_type: 'flex'` record after holder verification
- Reactions: one reaction per wallet per activity item

### events (`/api/projects/:projectId/events`)
- List events by project (filterable by status)
- Live events endpoint
- Manual event submission (authenticated)
- Auto-detected Twitter Spaces (via cron)

### wiki (`/api/wiki`)
- Get wiki by project ID
- Submit suggestions (any authenticated user)
- Suggestions enter moderation queue (`status: 'pending'`)

### wallets (`/api/wallets`)
- Connect wallet: creates/updates wallet record
- Holdings: groups held collections by project
- My events: upcoming events from all held projects (limit 50)
- My activity: recent activity from all held projects (limit 50)

### discovery (`/api/discovery`)
- Recommendations: collaborative filtering via `projectAffinity` table
- Echo score: portfolio diversity metric (0–100)

### search (`/api/search`)
- Case-insensitive ILIKE search across project names, slugs, collection names, and contract addresses
- Returns up to 10 projects + 10 collections

### admin (`/api/admin`)
- All endpoints protected by `AdminGuard`
- Dashboard stats: project count, user count, pending wiki suggestions, event count
- Project management: list (paginated), verify/unverify, delete
- Wiki moderation: list suggestions by status, approve (applies to wiki), reject
- Event management: list by status, update status, delete
- User management: list (paginated), set role
- Ownership: get/add/remove project owners with roles

### webhooks (`/api/webhooks`)
- Alchemy webhook receiver (Ethereum NFT transfers)
- Helius webhook receiver (Solana NFT transfers)
- Signature verification for Alchemy (HMAC-SHA256)

### health-score (internal service, no controller)
- Computes composite health score per project
- Consumed by the health score cron job

---

## Business Rules & Domain Logic

### Health Score Computation

The health score is a weighted average of 4 signals, clamped to 0–100:

| Signal | Weight | Scoring logic |
|--------|--------|---------------|
| **Holder count** | 30% | 0–30 for 0–100 holders; 30–70 for 100–1000; 70–100 for 1000+ |
| **Listed ratio** | 20% | 100 if ≤5% listed; scales to 50 at 20% listed; 0 if ≥50% listed. Lower listing ratio = healthier |
| **Activity (7d)** | 30% | 0–50 for 0–10 activities; 50–80 for 10–50; 80–100 for 50+; 100 at 100+ |
| **Events (30d)** | 20% | 0–50 for 0–2 events; 50–80 for 2–5; 80–100 for 5–10; 100 at 10+ |

The score is persisted to `projects.health_score` after computation.

### Echo Chamber Score

Measures portfolio diversity across community clusters:

```
diversityRatio = uniqueClusters / totalProjects
echoScore = round((1 - diversityRatio) * 100)
```

| Score range | Label |
|-------------|-------|
| 80–100 | Echo Chamber |
| 60–79 | Niche Collector |
| 40–59 | Balanced |
| 20–39 | Explorer |
| 0–19 | Trailblazer |

A wallet with no holdings returns `echoScore: null`. A wallet with holdings but no cluster assignments returns `echoScore: 50, label: 'Explorer'`.

### Holder Verification (Flex Posts)

Before a user can post a "flex" (showing off an NFT purchase):

1. Look up the collection by `collectionId` to determine the chain
2. **EVM chains (Ethereum, Base, Polygon, Abstract)**: Call Alchemy `isHolderOfContract` API using the chain-specific subdomain (e.g. `eth-mainnet`, `base-mainnet`, `polygon-mainnet`, `abstract-mainnet`)
3. **ApeChain**: Alchemy does not support ApeChain — verification is skipped (fail-open)
4. **Solana**: Call Helius DAS `getAssetsByOwner` — checks if the specific mint address is in the wallet's assets
5. If verification fails → `403 Forbidden: "Wallet does not hold this NFT"`
6. If API keys are not configured → **fail-open** (allow in dev, log warning)

Chain → Alchemy subdomain mapping is defined in `@nexus/types` (`CHAIN_META`).

### NFT Transfer Processing (Webhooks)

When an NFT transfer webhook fires:

1. Look up collection by contract address
2. If collection not tracked → skip silently
3. **Seller side**: Set `holders.is_current = false, quantity = 0` for the sender
4. **Buyer side**: Upsert holder record — increment quantity if exists, create if new
5. If transfer has a price > 0 → insert `activity_feed` record with `activity_type: 'sale'`

### Wiki Suggestion Flow

```
User submits suggestion → status: 'pending'
                          ↓
         Admin approves → status: 'approved'
                          → wiki field updated with proposed value
                          → revision_number incremented
                          → last_edited_by set to submitter
         Admin rejects  → status: 'rejected'
```

If no wiki exists for the project when a suggestion is approved, one is created.

### Project Ownership

- Roles: `owner` (full control) and `editor` (limited)
- A user can be re-assigned to a different role (upsert behavior)
- Only admins can manage ownership via the admin panel
- Cascade deletes: removing a project removes all ownership records

### Twitter Spaces Auto-Detection

Every 5 minutes:
1. Query all projects with a non-null `twitter_id`
2. For each, call `GET /2/spaces/by/creator_ids` with the Twitter API
3. For new spaces: insert as `events` with `source: 'auto_twitter'`
4. For existing spaces: update `status` if changed (live → ended, etc.)
5. Deduplication key: `twitter_space_id` column

### Trending Algorithm

Simple sort: `ORDER BY health_score DESC LIMIT 10`. Projects with higher health scores appear first on the homepage.

### Search Logic

Case-insensitive `ILIKE` pattern matching on:
- `projects.name`, `projects.slug`
- `collections.name`, `collections.contract_address`

Returns up to 10 results per entity type. No full-text index — uses PostgreSQL `ILIKE '%query%'`.

---

## Cron Jobs & Background Workers

| Cron | Schedule | Module | Description |
|------|----------|--------|-------------|
| `TwitterSpacesCron` | Every 5 minutes | events | Polls Twitter API for live/scheduled spaces on tracked projects |
| `HealthScoreCron` | Every hour | health-score | Recomputes health scores for all projects |

Both crons are registered via `@nestjs/schedule` and run within the NestJS process. They log progress and errors via NestJS `Logger`.

---

## Webhook Ingestion Pipeline

### Alchemy (Ethereum)

```
POST /api/webhooks/alchemy
  → Verify HMAC-SHA256 signature (x-alchemy-signature header)
  → Parse NFT_ACTIVITY events
  → For each activity: processNftTransfer()
```

### Helius (Solana)

```
POST /api/webhooks/helius
  → Parse nftTransfers array from each transaction
  → For each transfer: processNftTransfer()
```

### processNftTransfer()

```
1. Lookup collection by contract_address
2. If unknown collection → skip
3. Update seller's holder record (is_current: false)
4. Upsert buyer's holder record (is_current: true, quantity++)
5. If priced sale → insert activity_feed record
```

---

## Frontend Architecture

### Pages

| Route | Component | Auth | Description |
|-------|-----------|------|-------------|
| `/` | `page.tsx` | No | Homepage: search, trending, live events |
| `/search` | `search/page.tsx` | No | Search results (projects + collections) |
| `/discover` | `discover/page.tsx` | Yes | Personalized recommendations + echo score |
| `/me` | `me/page.tsx` | Yes | User's holdings, events, activity |
| `/me/card` | `me/card/page.tsx` | Yes | Shareable echo score card |
| `/project/[slug]` | `project/[slug]/page.tsx` | No | Project detail with tabs |
| `/project/[slug]/[collection]` | `project/[slug]/[collection]/page.tsx` | No | Collection detail + market history |
| `/admin` | `admin/page.tsx` | Admin | Dashboard stats |
| `/admin/projects` | `admin/projects/page.tsx` | Admin | Project management |
| `/admin/users` | `admin/users/page.tsx` | Admin | User management |
| `/admin/wiki` | `admin/wiki/page.tsx` | Admin | Wiki suggestion moderation |
| `/admin/events` | `admin/events/page.tsx` | Admin | Event management |
| `/api/og` | `api/og/route.tsx` | No | Dynamic OG image generation (Edge) |

### Component Hierarchy

```
RootLayout
  └─ Providers (Wagmi → ReactQuery → RainbowKit → Solana → Auth)
       └─ Navbar
            ├─ NavLinks (Discover, Search, My Communities, Admin*)
            └─ ConnectButton (EVM + Solana modal)
       └─ Page content
            ├─ AuthGate (for protected pages)
            └─ AdminGate (for admin pages, checks layout)
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `Navbar` | `components/layout/navbar.tsx` | Top nav with conditional admin link |
| `ConnectButton` | `components/wallet/connect-button.tsx` | Multi-chain wallet modal (EVM tab + Solana tab) |
| `AuthGate` | `components/wallet/auth-gate.tsx` | Renders children only when authenticated |
| `ProjectTabs` | `components/project/project-tabs.tsx` | Tab interface: Overview, Wiki, Events, Activity |
| `ActivityFeed` | `components/activity/activity-feed.tsx` | Renders activity items with reactions |
| `FlexForm` | `components/activity/flex-form.tsx` | Form to post a flex |
| `EventSubmitForm` | `components/events/event-submit-form.tsx` | Form to submit manual events |
| `WikiSuggestForm` | `components/wiki/wiki-suggest-form.tsx` | Form to suggest wiki edits |
| `SearchBar` | `components/search/search-bar.tsx` | Search input with client-side routing |

### State Management

- **Auth state**: React Context (`AuthProvider`) with localStorage persistence
- **Server state**: Direct `fetch` calls in server components; `apiFetch` utility for client components
- **Wallet state**: wagmi (EVM) + @solana/wallet-adapter (Solana), wrapped in `Providers`

### API Client

```typescript
// lib/api.ts
apiFetch<T>(path, { method?, body?, token? }) → Promise<T>
```
- Base URL: `NEXT_PUBLIC_API_URL` (default `http://localhost:4000/api`)
- Automatically adds `Authorization: Bearer` header when token provided
- Throws on non-OK responses with parsed error message

### Supported Chains

| Chain | Type | Chain ID | Currency | Smart Wallet |
|-------|------|----------|----------|-------------|
| Ethereum | EVM | 1 | ETH | — |
| Base | EVM | 8453 | ETH | Coinbase Smart Wallet |
| Abstract | EVM | 2741 | ETH | Abstract Global Wallet |
| ApeChain | EVM | 33139 | APE | — |
| Polygon | EVM | 137 | POL | — |
| Solana | SVM | — | SOL | — |

- **Base Smart Wallet**: Enabled automatically via Coinbase Wallet SDK (bundled with RainbowKit). Supports gasless transactions on Base.
- **Abstract Global Wallet**: Enabled via `@abstract-foundation/agw-react` `AbstractWalletProvider`. Provides embedded wallet experience on Abstract chain.

### Styling

- Tailwind CSS v4 with dark theme (gray-950 base)
- RainbowKit dark theme with purple accent (`#a855f7`)
- No component library — all custom Tailwind classes

---

## Configuration & Environment

### Required Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:password@localhost:5432/nexus` | PostgreSQL connection |
| `JWT_SECRET` | `nexus-dev-secret-change-in-production` | JWT signing key |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `4000` | API server port |
| `WEB_PORT` | `3000` | Frontend port |
| `NODE_ENV` | `development` | Environment |
| `ALCHEMY_API_KEY` | `""` | Ethereum RPC + NFT APIs + webhooks |
| `HELIUS_API_KEY` | `""` | Solana RPC + DAS API + webhooks |
| `TWITTER_BEARER_TOKEN` | `""` | Twitter API v2 for Spaces detection |
| `OPENSEA_API_KEY` | `""` | Market data |
| `RESERVOIR_API_KEY` | `""` | Floor prices, sales |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000/api` | API base URL for frontend |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | `""` | WalletConnect cloud project ID |

### Startup Validation

`apps/api/src/config/env.validation.ts` uses `class-validator` to validate env vars on boot. The app will crash with descriptive errors if `DATABASE_URL` or `JWT_SECRET` are missing/invalid. API keys are optional — features that depend on them degrade gracefully (log warnings, skip operations, or fail-open in dev).

---

## Deployment

### Docker

Multi-stage `Dockerfile` with two targets:

| Target | Base | Exposes | Command |
|--------|------|---------|---------|
| `api` | node:22-slim | 4000 | `node dist/main` |
| `web` | node:22-slim | 3000 | `pnpm start` |

### docker-compose.yml

Three services: `postgres` (16-alpine with healthcheck), `api`, `web`. API depends on postgres health; web depends on api.

### CI/CD (GitHub Actions)

```
Push/PR to main → lint → test → build → docker (main only)
```

### Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `pnpm dev` | `turbo dev` | Start all apps in watch mode |
| `pnpm build` | `turbo build` | Build all packages and apps |
| `pnpm lint` | `turbo lint` | Lint all packages |
| `pnpm test` | `turbo test` | Run all tests |
| `pnpm db:generate` | `drizzle-kit generate` | Generate migration SQL from schema changes |
| `pnpm db:migrate` | `drizzle-kit migrate` | Apply migrations to database |
| `pnpm db:studio` | `drizzle-kit studio` | Open Drizzle Studio GUI |
| `pnpm db:seed` | `tsx src/seed.ts` | Seed database with sample data |

---

## API Route Reference

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/nonce` | — | Generate nonce for wallet address |
| POST | `/api/auth/verify/evm` | — | Verify SIWE signature, get JWT |
| POST | `/api/auth/verify/solana` | — | Verify Solana signature, get JWT |
| POST | `/api/auth/refresh` | — | Refresh JWT tokens |
| GET | `/api/auth/me` | JWT | Get current user + wallets |

### Projects
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/projects` | — | List projects (paginated) |
| GET | `/api/projects/trending` | — | Top 10 by health score |
| GET | `/api/projects/:slug` | — | Project detail with collections, wiki, events |
| GET | `/api/projects/:slug/overlap` | — | Top 10 related projects by holder overlap |

### Collections
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/collections/:id` | — | Collection with project + market history |
| GET | `/api/collections/address/:address` | — | Lookup by contract address |

### Activity
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/projects/:projectId/activity` | — | Paginated activity feed |
| POST | `/api/projects/:projectId/activity/flex` | JWT | Post a flex (holder-verified) |
| POST | `/api/projects/:projectId/activity/:activityId/react` | JWT | React to activity |

### Events
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/projects/:projectId/events` | — | List events (filterable by status) |
| GET | `/api/projects/:projectId/events/live` | — | Currently live events |
| POST | `/api/projects/:projectId/events/submit` | JWT | Submit manual event |

### Wiki
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/wiki/:projectId` | — | Get project wiki |
| POST | `/api/wiki/suggest` | JWT | Submit wiki edit suggestion |

### Wallets
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/wallets/connect` | — | Connect wallet |
| GET | `/api/wallets/:address/holdings` | — | Holdings grouped by project |
| GET | `/api/wallets/:address/events` | — | Upcoming events from held projects |
| GET | `/api/wallets/:address/activity` | — | Recent activity from held projects |

### Discovery
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/discovery/recommendations/:address` | — | Personalized recommendations |
| GET | `/api/discovery/echo-score/:address` | — | Echo chamber score + label |

### Search
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/search?q=&chain=` | — | Search projects + collections |

### Webhooks
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/webhooks/alchemy` | Signature | Ethereum NFT transfer events |
| POST | `/api/webhooks/helius` | Header | Solana NFT transfer events |

### Admin
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/stats` | Admin | Dashboard counts |
| GET | `/api/admin/projects` | Admin | List projects (paginated) |
| PATCH | `/api/admin/projects/:id/verify` | Admin | Toggle verification |
| DELETE | `/api/admin/projects/:id` | Admin | Delete project |
| GET | `/api/admin/projects/:id/owners` | Admin | List project owners |
| POST | `/api/admin/projects/:id/owners` | Admin | Add project owner |
| DELETE | `/api/admin/projects/:id/owners/:userId` | Admin | Remove project owner |
| GET | `/api/admin/wiki/suggestions` | Admin | List wiki suggestions |
| PATCH | `/api/admin/wiki/suggestions/:id/approve` | Admin | Approve suggestion |
| PATCH | `/api/admin/wiki/suggestions/:id/reject` | Admin | Reject suggestion |
| GET | `/api/admin/events` | Admin | List all events |
| PATCH | `/api/admin/events/:id/status` | Admin | Update event status |
| DELETE | `/api/admin/events/:id` | Admin | Delete event |
| GET | `/api/admin/users` | Admin | List users (paginated) |
| PATCH | `/api/admin/users/:id/role` | Admin | Set user role |
