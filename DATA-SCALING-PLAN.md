# Data Scaling Plan

Phased plan for scaling NEXUS data storage and API retrieval, based on a full
codebase audit (2026-07-17) of the schema, indexing write path, and API read
path. Phase 1 is complete; later phases are TODO lists for future sessions.
Check items off as they land, and update the notes if the design changes.

## Why this exists

The growth pressure is not "Postgres is too small" — entity counts (users,
wallets, collections) are bounded and cheap. The pressure comes from
**multiplier tables** that grow with holders × days, or with every on-chain
transfer ever, combined with (pre-Phase-1) an in-process fire-and-forget write
path and request-time analytics. Fix the multipliers and the write path, and a
single Postgres instance comfortably serves this product for a long time.

Growth ranking from the audit (worst first):

| Table | Growth driver |
|---|---|
| `solana_raw_signatures` | every signature touching a tracked mint, with full raw RPC jsonb per row |
| `collection_holder_balance_history` | every NFT transfer ever (2 rows per EVM transfer) |
| `solana_parsed_transfers` / `solana_indexed_mints` | every Solana transfer / token |
| `collection_holder_history` | holders × days (snapshot job — **not yet scheduled**, see Phase 2) |
| `indexing_jobs` + `wallet_indexing_jobs` | every refresh (30-day retention added in Phase 1) |
| `*_affinity` tables | O(N²) pairwise; no PK, no indexes |
| `market_snapshots` | collections × interval; no PK |

---

## Phase 1 — Write path + correctness ✅ DONE (this branch)

Completed on `claude/data-scaling-concerns-im9zvh`:

- [x] **BullMQ + Redis job queues** replace all fire-and-forget
      `setTimeout`/`setImmediate` execution. Queues: `wallet-indexing`,
      `holder-indexing`, `collection-discovery`, `holder-history-scan`.
      Durable across restarts, retries with backoff, bounded concurrency,
      multi-instance safe. Redis provisioned in docker-compose and Dokploy
      (passworded, AOF, volume-backed, internal-only).
- [x] **Wallet indexing pagination** — full Alchemy `pageKey` / Helius page
      walk, with loud safety caps (5,000 NFTs per EVM chain, 10,000 Solana
      assets) that mark the fetch incomplete.
- [x] **Fail-loud fetches** — fetch failures throw and fail the job (BullMQ
      retries) instead of returning `[]`; empty strictly means "holds
      nothing".
- [x] **Stale-row reconciliation** — sold-out `wallet_holdings_snapshots` and
      exited `collection_holders` rows are deleted after each successful
      index (lastSeenAt stamp-and-sweep); skipped for page-cap-truncated
      chains.
- [x] **Batched writes** — 500-row chunked upserts in both indexing paths.
- [x] **Retention cron** — nightly prune of finished job rows >30 days and
      expired wallet-link challenges / move confirmations.
- [x] **SQL pagination for `listIndexingJobs`** — UNION ALL with pushed-down
      filters/sort/limit instead of loading both job tables into JS.
- [x] All web/API/package type errors fixed; `ignoreBuildErrors` removed.

### Known limitations accepted in Phase 1 (revisit if they bite)

- Backlog status derives from BullMQ counts: cap-exceeded "skips" are counted
  in `succeeded`, and counts reset when a new backlog run starts.
- Holder-history scan **progress** display still uses an in-memory map in
  `HolderHistoryService` — the scan itself is durable (DB checkpoints +
  BullMQ), but progress polling only works on the instance that runs it.
  Fine at 1 API instance; move progress to DB or job.updateProgress when
  scaling out.
- Admin single-collection "Index Holders" and metrics refreshes still run
  synchronously inside the HTTP request (short operations; dedupe window in
  DB). Move onto queues if request timeouts appear.
- Collection discovery still costs ~1 external API call per holder of the
  source collection; the queue serializes it but does not reduce the cost.

---

## Phase 2 — Storage architecture (do BEFORE turning on daily snapshots)

The daily holder snapshot job (`HolderSnapshotService.createAllSnapshots`) is
written but **deliberately not scheduled**. Do not wire the cron until the
first two items below are done — as designed it writes one row per holder per
day *including unchanged holders* ("for continuity"), projected ~182M rows /
~30GB per year at just 100 collections (see SNAPSHOTS.md).

- [ ] **Make holder snapshots delta-only.** Drop the unchanged-holder rows in
      `holder-snapshot.service.ts` (the `eventType: null` branch). Any day's
      state is reconstructable as "latest event ≤ date per (collection,
      address)". Update the retention/growth estimate in SNAPSHOTS.md.
- [ ] **Partition the big history tables by month** (`collection_holder_history`,
      `collection_holder_balance_history`, `solana_parsed_transfers`) before
      they get large — native Postgres range partitioning on the date/block
      timestamp column. Partitioning after the fact requires a table rewrite.
- [ ] **Then schedule the daily snapshot cron** (`@Cron` on
      `createAllSnapshots`) and backfill an initial snapshot per
      fully-indexed collection.
- [ ] **Stop keeping `solana_raw_signatures.raw_data` forever.** Null the
      jsonb out once `parse_status` is terminal (keep the signature row for
      dedupe/audit), or move raw payloads to object storage. This is the
      heaviest bytes-per-row offender in the DB.
- [ ] **Make holder-history scans incremental by default.** EVM already
      supports `fromBlock` resume; remove/limit the full delete-and-replay
      paths (`holder-history.service.ts` full-rescan and Solana Phase 4
      rebuild) so a routine scan never rewrites the whole collection's
      history.
- [ ] **Give `market_snapshots` a primary key** and a rollup/retention story
      (e.g. keep raw points 90 days, roll older into daily aggregates).
- [ ] **Fix the affinity tables**: add composite PKs (`(a_id, b_id)`) and
      reverse-lookup indexes to `collection_affinity` / `wallet_affinity`;
      **drop `project_affinity`** outright unless something starts writing it
      (it is read by `projects.getOverlap` and discovery recommendations but
      no code ever inserts into it — those reads see an empty table today).
- [ ] **Auto-skip persistently failing holder indexes.** Observed in prod
      (2026-07-17): Alchemy `getOwnersForContract` returns 500 for certain
      degenerate contracts (omnichain airdrops on Base), so those
      collections fail every backlog run forever and burn API calls until
      manually triaged. Mirror the cap-exceeded pattern: after repeated
      hard failures (e.g. 5xx on 2+ consecutive backlog runs), set
      `last_index_status = 'skipped'` with the error preserved — out of
      backlog rotation, still manually indexable from admin. Prefer this
      over marking collections `rejected`, which carries product meaning
      (hidden from surfaces) beyond "we can't index it".
- [ ] **Add missing FK indexes** flagged in the audit: `flex_reactions
      (activity_id)`, `project_owners (project_id, user_id)`,
      `wiki_suggestions (project_id, submitted_by)`, `events (project_id)`.
      Decide the fate of the legacy `holders` table (`users.ts`) — it has no
      indexes, no FK, no unique constraint; either index it or migrate its
      readers (`wallets.service`, discovery) to `collection_holders` and drop
      it.

---

## Phase 3 — Read path (when traffic, not data, is the pressure)

- [ ] **Precompute collection affinity on a schedule** into an indexed table,
      replacing the request-time multi-CTE holder-overlap queries in
      `collections.service.ts` (`getRelatedCollections`, network graph).
      Follow the proven health-score pattern: hourly cron writes, endpoints
      do cheap indexed reads. The 15-min in-process `networkGraphCache` then
      becomes unnecessary (it is also not shared across instances).
- [ ] **Cache layer for public reads.** Redis is now in the stack — add
      shared caching (or at minimum HTTP cache headers) for trending,
      featured, and collection detail endpoints. The homepage is
      `force-dynamic` with zero ISR; add `revalidate` to it and other
      server-rendered pages.
- [ ] **Bound the unbounded endpoints**: admin holder-history response loads
      ALL summaries + ALL balance-history rows for a collection
      (`admin/holder-history.service.ts:getCollectionHolderHistory`) —
      paginate the balance history; `wallets.getHoldings`,
      `discovery.getRecommendations`/`getEchoScore` load every `holders` row
      for a wallet — add limits or aggregate in SQL.
- [ ] **Fix remaining N+1 hot spots**: graph traversal runs the related-
      collections query once per visited node (up to 50/request); Solana
      reconciliation issues 2 queries per mismatched mint (up to 400/request);
      admin bulk operations loop one UPDATE per collection — make them
      set-based.
- [ ] **Move JS aggregation into SQL** where row counts grow: job-list
      merging is done (Phase 1); holder summary totals, wallet holdings
      grouping, and the O(edges × nodes) `.find()` loops in the network graph
      edge assembly remain.

---

## Phase 4 — Later / only if needed

- [ ] **Separate worker process.** Queues currently run inside the API
      process (fine at current scale). If indexing load starts starving API
      latency, split a `worker` entrypoint that registers only the processors
      and scale it independently. The queue architecture already supports
      this — it's a bootstrap change, not a redesign.
- [ ] **Multiple API instances.** Unblocked by Phase 1 (Redis-backed locks).
      Before doing it: move holder-history scan progress out of instance
      memory (see Phase 1 limitations) and add shared caching (Phase 3).
- [ ] **Columnar store (ClickHouse/Timescale) for transfer history.** Only if
      the product commits to full transfer-level history for *every* tracked
      collection at large scale. With Phase 2 done (partitioning, deltas, raw
      payload eviction), Postgres handles hundreds of millions of history
      rows; do not reach for this early.
- [ ] **External API budget.** Discovery's per-holder call pattern is the
      dominant Alchemy/Helius cost driver. If bills or 429s grow: add a
      global rate limiter shared across queues (BullMQ limiter covers
      holder-indexing only), and consider caching per-wallet holdings lookups
      that discovery repeats.

---

## Operating notes

- Redis is required infrastructure for the API as of Phase 1 (`REDIS_URL`).
  BullMQ needs `maxmemory-policy noeviction` (Redis default — never set
  `maxmemory` on this instance). Keep Redis at 1 replica.
- Job history: BullMQ keeps completed jobs 24h / failed 7d; the DB job tables
  keep finished rows 30 days (retention cron, 4am UTC).
- First index run after Phase 1 deploys will show a `staleRemoved` spike in
  job stats — that's the one-time cleanup of accumulated stale rows.
- `ALCHEMY_API_KEY` / `HELIUS_API_KEY` must be set or indexing jobs fail
  visibly (by design — a missing key must not look like empty wallets).
