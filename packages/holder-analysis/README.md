# @nexus/holder-analysis

The holder analysis for one project, as pure TypeScript with no I/O: balances over time, who
holds what, how long since each holder did anything (active, quiet, parked, dormant by years),
the wake-up outlook, groups of wallets that are likely one person, and the activity feed.

`src/analyze.ts`, `src/csv.ts` and the tests come unchanged from the holder analysis Worker
(spooky-bar `apps/holder-analysis`, through PR #189). `src/config.ts` is that Worker's project
and collection checks without its D1 storage. In Nexus, the API builds a `Project` from
`projects`, `collections` and `holder_analysis_collection_settings`, and feeds `analyze()` from
`collection_transfers` and `wallet_profiles` (tables in `@nexus/database`, migration 0037).

```sh
pnpm --filter @nexus/holder-analysis test        # node:test via tsx
pnpm --filter @nexus/holder-analysis typecheck   # src, tests and scripts
```

`scripts/from-cache.ts` is a regression check against the offline SBCC scripts' cache of
2026-10-23 (not in this repo): `npx tsx scripts/from-cache.ts <data dir> [out dir]` should
reproduce analyze.py's results exactly.
