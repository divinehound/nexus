# NEXUS — Product Requirements Document

**Tagline:** The Dexscreener for NFT Projects & Communities

## Vision

NEXUS is a unified discovery and intelligence platform for NFT communities. Just as Dexscreener became the go-to dashboard for DeFi tokens, NEXUS aims to be the definitive hub for NFT project intelligence — aggregating on-chain data, community signals, Twitter Spaces, and holder overlap into a single, searchable experience.

## Target Chains

- Ethereum (ERC-721 / ERC-1155)
- Solana (SPL tokens)

## Core Features

### 1. Project Pages (`/project/:slug`)

Every NFT project gets a comprehensive page with four tabs:

- **Overview** — Project metadata, social links, health score, market data (floor price, volume, holder count, listed count), collection cards
- **Wiki** — Community-editable markdown description and auto-generated timeline. Holders can suggest edits; verified holders get priority
- **Events** — Aggregated calendar of Twitter Spaces, AMAs, mints, collabs, IRL events. Auto-detected from Twitter API + manual submissions
- **Activity Feed** — Real-time feed of notable sales, whale moves, milestones, and "flex" posts (verified holder purchase shares). Users can react to activity items

### 2. Collection Detail (`/project/:slug/:collection`)

Drill-down page per collection within a project, showing:
- Contract address, chain, supply, mint date
- Market snapshot (floor, volume, holders, listed)
- Holder distribution and notable holders

### 3. Search (`/search?q=`)

Full-text search across projects and collections. Supports:
- Project name search
- Contract address lookup
- Chain filtering

### 4. Discover (`/discover`)

Wallet-gated personalized recommendations:
- **Tier 1 Recommendations** — Projects with high holder overlap to your current holdings (collaborative filtering via `projectAffinity` and `collectionAffinity` tables)
- **Echo Chamber Score** — A metric (0–100) measuring how insular a user's portfolio is across community clusters. High score = concentrated in one cluster; low score = diverse
- Requires wallet connection to function

### 5. My Communities (`/me`)

Personal dashboard (wallet-gated) showing:
- Projects the user holds NFTs in
- Aggregated events feed from all held projects
- Aggregated activity feed from all held projects

### 6. Echo Score Card (`/me/card`)

Shareable card showing a user's echo score with social sharing capability (OG image generation).

### 7. Home Page (`/`)

Landing page with:
- Search bar (primary CTA)
- Trending projects (sorted by health score)
- Live Now section (active Twitter Spaces)
- Most Active section (highest recent activity)

### 8. OG Images (`/api/og`)

Dynamic Open Graph image generation for social sharing.

## Data Model

### Projects & Collections
- Projects have multiple collections (1:N)
- Each collection is a single contract on a single chain
- Projects are identified by slug; collections by contract address

### Users & Wallets
- Users can connect multiple wallets across chains
- One wallet is designated as primary
- Wallets resolve ENS (Ethereum) and SNS (Solana) names

### Holders
- Tracks which wallets hold which collections
- Includes quantity, first acquired date, and current status
- Synced via blockchain webhooks (Alchemy for ETH, Helius for SOL)

### Discovery
- `projectAffinity` — Overlap between project holder bases
- `collectionAffinity` — Overlap between collection holder bases
- `walletAffinity` — Similarity between wallet portfolios
- `clusters` — Community groupings computed from affinity data

### Market Data
- `marketSnapshots` — Time-series floor price, volume, holder count, listed count per collection

### Activity & Events
- Activity types: sale, notable_sale, whale_move, milestone, flex
- Event types: spaces, ama, mint, collab, irl, other
- Event sources: auto_twitter, manual, on_chain
- Event statuses: upcoming, live, ended

## Health Score

An 8-signal composite score (0–100) for ranking and trending:
1. Floor price stability
2. Volume trend (7d)
3. Holder count trend
4. Unique holder ratio
5. Listed ratio (lower = healthier)
6. Community activity score
7. Twitter engagement metrics
8. Event frequency

## Authentication

- **Sign-In with Ethereum (SIWE)** — Primary auth mechanism
- Wallet connection via WalletConnect / injected providers
- JWT tokens for API session management
- No email/password auth — pure wallet-based identity

## Integrations

| Service | Purpose |
|---------|---------|
| Alchemy | Ethereum NFT data, webhooks for transfers |
| Helius | Solana NFT data, webhooks for transfers |
| Twitter/X API | Spaces detection, engagement metrics |
| OpenSea | Market data, collection metadata |
| Reservoir | Floor prices, sales data, listings |

## Tech Stack

- **Monorepo:** Turborepo + pnpm workspaces
- **API:** NestJS 11, TypeScript 5.7
- **Frontend:** Next.js 15, React 19, Tailwind CSS v4
- **Database:** PostgreSQL (Supabase), Drizzle ORM
- **Shared Packages:** `@nexus/database` (schemas), `@nexus/types` (interfaces), `@nexus/eslint-config`

## API Endpoints

### Auth
- `POST /auth/nonce` — Get SIWE nonce for a wallet address
- `POST /auth/verify` — Verify SIWE signature, return JWT
- `GET /auth/me` — Get current user (JWT required)
- `POST /auth/refresh` — Refresh JWT token

### Projects
- `GET /projects` — List projects (with pagination)
- `GET /projects/trending` — Trending projects by health score
- `GET /projects/:slug` — Project detail
- `GET /projects/:slug/overlap` — Community overlap data

### Collections
- `GET /collections/:id` — Collection detail
- `GET /collections/address/:address` — Lookup by contract address

### Wiki
- `GET /wiki/:projectId` — Get project wiki
- `POST /wiki/suggest` — Submit wiki edit suggestion

### Events
- `GET /projects/:projectId/events` — Project events
- `GET /projects/:projectId/events/live` — Currently live events
- `POST /projects/:projectId/events/submit` — Submit manual event

### Activity
- `GET /projects/:projectId/activity` — Activity feed
- `POST /projects/:projectId/activity/flex` — Post a flex (auth required)
- `POST /projects/:projectId/activity/:activityId/react` — React to activity (auth required)

### Wallets
- `POST /wallets/connect` — Connect wallet, trigger holdings sync
- `GET /wallets/:address/holdings` — Holdings grouped by project
- `GET /wallets/:address/events` — Aggregated events
- `GET /wallets/:address/activity` — Aggregated activity

### Discovery
- `GET /discovery/recommendations/:address` — Personalized recommendations
- `GET /discovery/echo-score/:address` — Echo chamber score

### Search
- `GET /search?q=` — Full-text search
- `GET /search?chain=` — Filter by chain

### Webhooks
- `POST /webhooks/alchemy` — Alchemy webhook receiver
- `POST /webhooks/helius` — Helius webhook receiver

## Non-Functional Requirements

- Mobile-responsive design (dark theme, gray-950 background)
- Sub-200ms API response times for cached queries
- Real-time updates via webhook processing
- SEO-friendly with server-side rendering (Next.js)
- Open Graph image generation for social sharing
