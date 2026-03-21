# NEXUS (dev)

Current dev deployment:
- Web: `https://nexus.dev.intentionworks.xyz`
- API: `https://api.nexus.dev.intentionworks.xyz`

Shared database strategy:
- Shared Postgres host: `dev-postgres`
- Dev DB: `nexus_dev`
- MVP DB: `nexus_mvp`
- App users are isolated (`nexus_app` for nexus DBs, `mealman_app` for mealman DB)

---

## Core behavior implemented

### 1) Contract-first intake (Dexscreener-style)
- User can submit/look up unknown contract addresses.
- API immediately tracks collection via:
  - `POST /api/collections/track`
- Web routes user to:
  - `/collection/[chain]/[contract]`
- Collection is visible even when unverified.

### 2) Verification/mapping lifecycle
Collection statuses:
- `tracked_unverified`
- `pending_claim`
- `verified`
- `rejected`

Mapping statuses:
- `unmapped`
- `suggested`
- `mapped`
- `rejected`

Trust disclaimer shown for unverified/rejected:
- `Tracked, not yet verified. Data may be incomplete or unaffiliated.`

### 3) Featured projects
- Public endpoint:
  - `GET /api/projects/featured?limit=...`
- Admin-only toggle:
  - `PATCH /api/admin/projects/:id/featured`

### 4) Admin curation queue
- Web admin review UI:
  - `/admin/collections`
- Supports verify/reject/suggest-project actions.
- Shows collection images, stats (supply, holders, floor price)
- Includes blockchain explorer links (Etherscan, Basescan, Polygonscan, etc)
- **Re-enrich Metadata** button to refresh blockchain data for collections
- Visual "Invalid Address" badges for malformed contract addresses

### 5) Admin indexing queue visibility + index status controls
- Web admin indexing UI:
  - `/admin/indexing`
  - Includes quick status lookup panels for wallet, collection, and project.
  - **Accepts wallet addresses OR UUIDs** for lookups and refresh triggers
  - Includes manual reindex triggers for wallet, collection, and project.
- API endpoints:
  - Jobs
    - `GET /api/admin/indexing/jobs?status=&walletId=&page=&limit=`
    - `GET /api/admin/indexing/jobs/:id`
    - `POST /api/admin/indexing/jobs/:id/retry`
  - Status lookups (normalized payload, accepts ID or address/contract)
    - `GET /api/admin/indexing/status/wallet/:walletIdOrAddress`
    - `GET /api/admin/indexing/status/collection/:idOrContract`
    - `GET /api/admin/indexing/status/project/:idOrSlug`
  - Manual refresh triggers (accepts ID or address/contract)
    - `POST /api/admin/indexing/wallet/:walletIdOrAddress/refresh`
    - `POST /api/admin/indexing/collection/:id/refresh`
    - `POST /api/admin/indexing/project/:id/refresh`
  - Collection metadata enrichment
    - `POST /api/admin/collections/:id/enrich`

### 6) Auto-index trigger workflow
- `POST /api/collections/track` now triggers an immediate initial collection metrics refresh.
  - This guarantees at least one snapshot attempt without requiring manual admin refresh.
- `POST /api/admin/collections/:id/verify` now auto-refreshes:
  - the verified/mapped collection
  - the destination project
  - and, when mapping moves between projects, the previous project as well.
- `PATCH /api/admin/projects/:id/verify` with `{ "isVerified": true }` now auto-refreshes the project and its child collections.
- All auto-triggered collection/project refresh jobs use a short idempotency window (3 minutes) to dedupe repeated actions and return the existing recent job id instead of queue-spamming.

### 7) Real blockchain indexing
- **EVM chains**: Uses Alchemy `getNFTsForOwner` API
  - Indexes all supported chains: Ethereum, Base, Polygon, Abstract, ApeChain
  - Same EVM address is queried across all chains
- **Solana**: Uses Helius `getAssetsByOwner` API
  - Solana-only indexing (different address format)
- Collections are auto-enriched with:
  - Real collection name (from blockchain metadata)
  - Collection image
  - Total supply
  - Token type (ERC721/ERC1155/SPL)
- **No mock data** - all wallet holdings are real blockchain data

---

## Admin auth + gating

All `/api/admin/*` routes require:
- `Authorization: Bearer <jwt>`
- Authenticated user with `role = "admin"`

Failure semantics:
- `401` missing/invalid token
- `403` authenticated but non-admin user

Web `/admin` routes are role-gated and show blocked state for non-admin users.

---

## API endpoints (current)

### Collections

#### `POST /api/collections/track`
Request:
```json
{
  "chain": "ethereum",
  "contractAddress": "0x1234567890abcdef1234567890abcdef12345678"
}
```
Response (202):
```json
{
  "statusCode": 202,
  "collectionId": "uuid",
  "status": "tracked_unverified",
  "routeHint": "/api/collections/ethereum/0x1234567890abcdef1234567890abcdef12345678",
  "indexing": {
    "queued": true,
    "deduped": false,
    "jobId": "uuid"
  }
}
```

#### `GET /api/collections/:chain/:contractAddress`
Returns tracked collection details, verification/mapping status, project/proposed project, and metrics placeholders.

### Projects

#### `GET /api/projects/trending`
Used by homepage Trending and Most Active sections.

#### `GET /api/projects/featured?limit=6`
Returns featured projects only.

### Admin collections

#### `POST /api/admin/collections/:id/verify`
```json
{
  "projectId": "uuid",
  "notes": "Manual review complete"
}
```

#### `POST /api/admin/collections/:id/reject`
```json
{
  "notes": "Invalid contract metadata"
}
```

#### `POST /api/admin/collections/:id/suggest-project`
```json
{
  "projectId": "uuid",
  "confidence": 0.82,
  "notes": "High overlap in holder graph"
}
```
(`confidence` must be `0..1`)

#### `POST /api/admin/collections/:id/enrich`
Re-fetches blockchain metadata (name, image, supply, token type) for a collection.
Useful for backfilling collections that were tracked before enrichment was implemented.

Response:
```json
{
  "success": true,
  "collection": { ... },
  "metadata": { ... }
}
```

### Admin projects

#### `PATCH /api/admin/projects/:id/featured`
```json
{
  "isFeatured": true
}
```

### Identity + Wallet Management (User Identity v1)

All routes require `Authorization: Bearer <jwt>`.

#### `GET /api/me`
Returns profile + wallets and computed `displayName` fallback order:
1. stored `display_name`
2. ENS from linked wallets
3. abbreviated primary wallet address

#### `PATCH /api/me/profile`
```json
{
  "displayName": "Papa",
  "avatarUrl": "https://...",
  "bio": "Collector and builder"
}
```

#### `POST /api/me/wallets/challenge`
```json
{
  "chain": "ethereum",
  "address": "0x1234567890abcdef1234567890abcdef12345678",
  "purpose": "link_wallet"
}
```
For wallet move confirmations, use `purpose: "move_wallet"` and pass `confirmationToken`.
Response:
```json
{
  "nonce": "...",
  "message": "NEXUS Wallet Verification\nPurpose: link_wallet\n..."
}
```

#### `POST /api/me/wallets/verify`
```json
{
  "chain": "ethereum",
  "address": "0x1234567890abcdef1234567890abcdef12345678",
  "message": "...",
  "signature": "0x..."
}
```
Behavior:
- unowned wallet: linked to current user + triggers wallet holdings indexing
- already owned by current user: idempotent success
- owned by another user: `409 WALLET_ALREADY_LINKED` with `confirmationToken`

Signature verification notes:
- EVM chains: supports both EOA signatures and smart contract wallets (ERC-6492)
  - Coinbase Smart Wallet (passkey-based) fully supported
- Solana: verifies base58 `signMessage` signature against the exact challenge message and base58 public key

**Wallet indexing behavior:**
- EVM wallets: indexes all supported chains (Ethereum, Base, Polygon, Abstract, ApeChain)
- Solana wallets: indexes Solana only
- Collections auto-created with real metadata from blockchain
- Top 50 collections (by token count across all chains) are tracked

#### `POST /api/me/wallets/move`
```json
{
  "chain": "ethereum",
  "address": "0x1234567890abcdef1234567890abcdef12345678",
  "confirmationToken": "...",
  "message": "... includes Confirmation Token: ...",
  "signature": "0x..."
}
```
Behavior:
- requires valid `confirmationToken`
- requires a fresh `move_wallet` challenge + signature over that challenge message
- validates token expiry + signature
- atomically reassigns wallet
- records wallet ownership move audit row

#### Wallet management
- `GET /api/me/wallets`
- `PATCH /api/me/wallets/:id/primary`
- `DELETE /api/me/wallets/:id`

Delete policy: safe by default. API forbids deleting the final linked wallet (`LAST_WALLET_DELETE_FORBIDDEN`).

**Disconnect behavior:** Wallet disconnect now properly disconnects both wagmi (EVM) and Solana wallet adapters before clearing app auth state.

---

## Mobile UI

### Navigation
- **Mobile** (< 768px): Hamburger menu with slide-down navigation
- **Desktop** (≥ 768px): Horizontal nav bar
- Active page highlighting in both modes
- Touch-friendly tap targets (44px minimum)

---

## Database schema notes

### Wallet uniqueness
- Case-insensitive unique constraint on `(chain, lower(address))` for non-Solana chains
- Prevents duplicate wallet records with different address casing
- Solana addresses remain case-sensitive

### Collection enrichment
Collections now store:
- `name`: Real collection name from blockchain
- `imageUrl`: Collection image URL
- `supply`: Total supply
- `collectionType`: Token standard (erc721, erc1155, spl)

Auto-populated during wallet indexing via Alchemy/Helius APIs.

---

## Deployment + migrations

`dev` branch redeploys web/api via Dokploy.

API startup runs migrations by default before boot:
- env: `RUN_MIGRATIONS_ON_BOOT=true`
- set `false` to disable startup migration run.

Migration source:
- `packages/database/drizzle/*`

Recent migrations:
- `0010_wallet_case_insensitive_uniqueness.sql`: Prevents duplicate wallets with different casing

---

## Environment variables

### Required API keys
- `ALCHEMY_API_KEY`: For EVM chain indexing (Ethereum, Base, Polygon, etc)
- `HELIUS_API_KEY`: For Solana indexing
- `WALLETCONNECT_PROJECT_ID`: For WalletConnect integration

### Optional
- `RUN_MIGRATIONS_ON_BOOT`: `true` (default) or `false`

---

## Notes for ops

- API currently uses functional endpoint checks (for example `GET /api/projects?limit=1`) instead of a dedicated health route.
- If homepage content appears stale, force refresh and check API output directly first (`/api/projects/trending`, `/api/projects/featured`).
- Wallet indexing can be manually triggered via admin panel using either wallet UUID or address
- Collection metadata can be refreshed via "Re-enrich Metadata" button in admin collections review
