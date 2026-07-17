# Nexus — Product Vision

> **Nexus is the canonical record and live market lens for every NFT community** — Wikipedia's trust and permanence, Dexscreener's data density and freshness, connected by the holder graph.

Someone should be able to land on a Nexus page and, in one place, understand a project: what it is, who is behind it, where its community lives, how it trades, how healthy its holder base is, and what people who actually hold it think. From there, Nexus should lead them somewhere new — communities that overlap with theirs, and collections outside their echo chamber.

This document captures what the original plan gets right, the gaps we need to close, how the pieces fit into one cohesive experience, and the order to build it in. Nexus already covers EVM and Solana; multichain is a standing constraint throughout, not a future phase.

---

## 1. What the plan already gets right

- **The collection page as the atomic unit.** Summary, team, social links, secondary-market links, price history, and reviews in one canonical place. Everything else in the product hangs off this page.
- **Holder overlap as the discovery mechanism.** "Which communities share holders with mine" and "show me collections outside my echo chamber" are questions nobody answers well today, and they fall naturally out of data we need anyway.
- **Two-sided value.** Collections get metrics about holder health; individuals get better portfolio tracking. Each side's activity makes the product better for the other.

---

## 2. Gap analysis — what's missing

### a. The canonical-identity problem (this is actually the core asset)

Dexscreener works because a token contract is ground truth. NFT projects are messier: scam clones with identical art, migrated or upgraded contracts, multi-collection brands spanning several contracts and chains, bridged and wrapped copies. Solana adds its own layer (candy machines, compressed NFTs, collection authorities) alongside EVM contract addresses.

Nexus needs a **canonical registry**: one page per *community*, mapping N contracts across N chains to it, each mapping carrying a verification status. Nobody does this well. It is the defensible layer under everything else — the registry is what makes a Nexus page *the* page for a project rather than one of many.

### b. Who writes the wiki? (the editorial model)

A wiki needs an authorship answer or it stays empty or becomes untrustworthy. The model:

- **AI-drafted, source-cited baseline pages** generated from indexed data and public sources, so every collection has a useful page before any human touches it.
- **Community edit proposals** layered on top, with visible edit history.
- **"Claim your collection":** teams verify ownership via a wallet signature from the deployer/creator/update-authority address. Claimed pages get an "official" badge and team-editable sections; unclaimed pages stay neutral and clearly say so.

The claim flow doubles as the future B2B wedge — it is how teams enter the product.

### c. Trust and safety — the reason users pick Nexus over hype channels

Reviews will be sybil-gamed and scam projects will self-promote; this is a certainty, not a risk. The review model is **open with weighting**: anyone can review, but reviews from verified holders (wallet-linked) are badged and ranked higher, with holding duration increasing weight. Moderation and scam/rug flagging operate under evidence standards.

Beyond reviews, every claim on a page carries a **provenance label**: on-chain fact, team-provided, or community-contributed. Trust is the brand. A pay-to-play trending list — Dexscreener's model — would poison it; we monetize elsewhere (see §2i).

### d. The retention loop

A wiki is read once; Dexscreener is checked hourly. Without a reason to return, Nexus is an SEO destination, not a habit. The loop:

- **Watchlists** on collections and wallets.
- **Alerts**: floor moves, listing spikes, holder-count shifts, team-wallet movements, and page edits on collections you hold.
- **A personal feed** assembled from your holdings and watchlist.

### e. Distribution and cold start

The go-to-market is **programmatic SEO**. Every indexed collection gets a well-structured, pre-seeded page — the same way Dexscreener ranks for essentially every token search — generated before any user shows up. The wiki content is simultaneously the SEO moat: pages that answer "what is X, who made it, is it legit" rank for exactly the searches collectors make. Launch motion: index the top N thousand collections across EVM and Solana, generate baseline pages, then let claims, reviews, and edits enrich them.

### f. Data pipeline economics and risk (the hard engineering decision)

The NFT data-infrastructure landscape is unstable — SimpleHash shut down in 2025 and Reservoir sunset its NFT aggregation API. Buy-vs-build must be decided per layer:

- **Buy**: metadata, prices, and market activity via vendor APIs (Alchemy / Moralis / NFTScan / OpenSea on EVM; Helius / Tensor on Solana), behind an internal abstraction so a vendor shutdown is a migration, not a rewrite.
- **Build**: **holder snapshots must be first-party.** Overlap analysis, holder-health metrics, and duration-weighted review scoring all require our own periodic holder-state store across both ecosystems. Vendors can tell you who holds a collection *now*; they cannot give you holder state *over time*, and the time dimension is what makes "health" and "overlap" meaningful.

The snapshot store is the second defensible asset after the registry. **Snapshotting must start well before any analytics ship** — the metrics are only as good as the history behind them, and history cannot be backfilled.

### g. Historical memory (the Wikipedia angle, taken seriously)

Dead, rugged, and legacy collections still deserve pages. Nobody else preserves this; it is unique content, strong SEO, and genuinely useful due diligence ("this founder's last project collapsed"). It requires evidence and citation standards, and a careful wording policy — stating on-chain facts with linked sources rather than editorial verdicts like "rug," which carry defamation risk.

### h. Privacy and wallet-labeling policy

Holder analysis and portfolio tools brush against wallet doxxing. The policy: aggregate statistics are fair game; labeling individual wallets with real-world identities happens only when self-claimed or already public. This needs to be written down before the holder tools ship, not after the first incident.

### i. Monetization (decided early because it constrains trust design)

- **Free forever**: canonical pages and core market data — that is the moat and the trust foundation.
- **Paid**: pro analytics for traders (deeper holder-health data, higher alert limits), team tools on claimed pages (audience analytics, announcements), and API access.
- **Never**: paid placement in rankings, trending, or discovery. Wikipedia rules for content and rankings; Dexscreener energy for data density; monetize *tools*, not *placement*.

### j. Legal hygiene

Price data, "health scores," and reviews sit adjacent to financial advice. Needed: standard disclaimers, a written review-moderation policy, and a DMCA process for image and metadata display.

---

## 3. The cohesive experience — three layers, one flywheel

### Object layer — the Collection Page (the atom)

| Tab | Contents |
| --- | --- |
| **Overview** | Verified identity and registry status, links (socials, marketplaces), AI-drafted cited summary, team, project timeline |
| **Market** | Price/floor history, volume, listings, marketplace deep-links |
| **Holders** | Holder count and distribution over time, health metrics, top overlapping communities |
| **Community** | Weighted reviews, activity, page-edit history |

### Discovery layer — how people find communities

- **Screener/rankings grid** (the Dexscreener view) with filters across chains
- **Overlap explorer**: "holders of X also hold…" — list and graph views
- **Search and recommendations** ("collections like this," "outside your echo chamber") powered by the holder graph

### Personal layer — the logged-in experience

- Wallet connect → **portfolio**: value, P&L, holdings history across EVM and Solana
- Your holdings automatically become **your communities** → personalized feed, watchlist, alerts
- Your verified holdings determine your **review weight** and badge

### The flywheel

SEO page → visitor gets the canonical summary plus live data → connects a wallet for portfolio and watchlist → alerts bring them back → as a verified holder they review and propose edits → richer pages → better SEO and a denser holder graph → better discovery for everyone.

Every feature should be justifiable by its place in this loop. If it doesn't feed the flywheel, it waits.

---

## 4. Phased roadmap (sequenced by data dependencies)

The distinctive features — overlap, holder health, recommendations, weighted reviews — all sit downstream of one asset: first-party holder history. The roadmap is ordered so that asset starts accruing as early as possible.

**Phase 0 — Decisions.** Data vendor selection per ecosystem (spike comparing Alchemy / Moralis / NFTScan / OpenSea and Helius / Tensor), stack choices. Chain scope (EVM + Solana) and review model (open with weighting) are already decided.

**Phase 1 — Canonical pages, read-only.** Canonical registry; ingestion of top collections across both ecosystems; collection pages (Overview + Market); screener grid; programmatic SEO. No accounts yet. **Start first-party holder snapshotting in this phase**, even though nothing surfaces it — history accrues value from day one.

**Phase 2 — Holder analytics.** Surface the snapshot store: holder-health metrics, overlap explorer, recommendations.

**Phase 3 — Identity and retention.** Wallet auth, portfolio, watchlists and alerts, open-with-weighting reviews, community edit proposals.

**Phase 4 — Claim and monetize.** Claim-your-collection, team tools on claimed pages, pro tier, public API.

---

## 5. Remaining open decisions

- **Data vendor selection** — requires the Phase 0 spike.
- **Monetization boundaries** — confirm the no-paid-placement stance as policy.
- **Wallet-labeling privacy policy** — specifics to be written before holder tools ship.
