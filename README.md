# NEXUS (dev)

Current dev deployment:
- Web: `https://nexus-dev.intentionworks.xyz`
- API: `https://nexus-dev-api.intentionworks.xyz`

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
  "routeHint": "/api/collections/ethereum/0x1234567890abcdef1234567890abcdef12345678"
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

### Admin projects

#### `PATCH /api/admin/projects/:id/featured`
```json
{
  "isFeatured": true
}
```

---

## Deployment + migrations

`dev` branch redeploys web/api via Dokploy.

API startup runs migrations by default before boot:
- env: `RUN_MIGRATIONS_ON_BOOT=true`
- set `false` to disable startup migration run.

Migration source:
- `packages/database/drizzle/*`

---

## Notes for ops

- API currently uses functional endpoint checks (for example `GET /api/projects?limit=1`) instead of a dedicated health route.
- If homepage content appears stale, force refresh and check API output directly first (`/api/projects/trending`, `/api/projects/featured`).
