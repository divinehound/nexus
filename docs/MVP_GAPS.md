# MVP Gaps Task List

Remaining work to reach a deployable MVP. Items are ordered by priority within each tier.

---

## High Priority

- [ ] **OG image generation** — The `/api/og` route exists but doesn't render dynamic project cards. Needed for link previews when sharing projects on Twitter/Discord.
- [ ] **Drizzle migrations** — Schema is defined but no migration files have been generated yet (`drizzle-kit generate` + `drizzle-kit migrate`). Required before first deploy.
- [ ] **Seed script** — No way to bootstrap an initial admin user or sample data for development.

## Medium Priority

- [ ] **Live Twitter Spaces detection** — The event system supports `auto_twitter` source but there is no cron/worker that polls the Twitter API for live spaces.
- [ ] **Health score cron job** — `HealthScoreModule` exists but there is no scheduled recomputation. Needs a `@Cron()` decorator or external trigger.
- [ ] **On-chain holder verification for flex posts** — The activity controller has a TODO to verify the wallet actually holds the NFT before allowing a flex post.
- [ ] **Nav link to admin** — The main site nav doesn't expose an admin link for admin users.

## Lower Priority

- [ ] **Rate limiting** — No throttle guard on public API endpoints.
- [ ] **Environment config validation** — No `.env.example` or Zod/Joi validation of required env vars.
- [ ] **Tests** — No unit or e2e tests for any module.
- [ ] **Docker / deploy config** — No Dockerfile, docker-compose, or CI/CD pipeline.
