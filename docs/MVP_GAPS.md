# MVP Gaps Task List

Remaining work to reach a deployable MVP. Items are ordered by priority within each tier.

---

## High Priority

- [x] **OG image generation** — Dynamic project cards with image, stats (health score, floor price, holders, listed %). Supports both generic and project-specific cards via query params.
- [x] **Drizzle migrations** — Initial migration SQL generated from all schema definitions. Migration runner utility added.
- [x] **Seed script** — `pnpm db:seed` bootstraps an admin user, sample project, collection, event, wiki entry, and activity.

## Medium Priority

- [x] **Live Twitter Spaces detection** — `TwitterSpacesCron` polls every 5 minutes for live/scheduled spaces on projects with a `twitterId`, auto-creates events with `auto_twitter` source.
- [x] **Health score cron job** — `HealthScoreCron` recomputes all project health scores every hour via `@Cron(EVERY_HOUR)`.
- [x] **On-chain holder verification for flex posts** — `HolderVerificationService` checks ERC-721 ownership (Alchemy) and SPL ownership (Helius DAS) before allowing flex posts. Throws `ForbiddenException` if wallet doesn't hold the NFT.
- [x] **Nav link to admin** — Admin link shown in navbar when `user.role === 'admin'`.

## Lower Priority

- [x] **Rate limiting** — Global `ThrottlerGuard` via `@nestjs/throttler` (60 req/min per IP).
- [x] **Environment config validation** — `class-validator` based validation runs at startup. Required: `DATABASE_URL`, `JWT_SECRET`. Optional: API keys.
- [x] **Tests** — Jest configured for API. Unit tests for `HealthScoreService` and `ActivityService` (holder verification flow).
- [x] **Docker / deploy config** — Multi-stage `Dockerfile` (api + web targets), updated `docker-compose.yml`, and GitHub Actions CI pipeline (lint, test, build, docker).
