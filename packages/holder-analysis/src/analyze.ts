// The holder analysis for one project, from everything the sync has stored: balances over
// time, who holds what now, how long since each holder did anything (active, quiet, parked,
// dormant by years), the wake-up outlook from activity outside the project, and groups of
// wallets that are likely one person. A port of the offline scripts' analyze.py (2026-10-23),
// with the Spooky Boys contracts replaced by the project's collections. Pure: no I/O.
//
// Times are unix seconds in here (ms only at the D1 edge).

import type { Collection, Project } from "./config";

export type Transfer = {
  contract: string;
  block: number;
  logIndex: number;
  /** unix seconds */
  at: number;
  tx: string;
  from: string;
  to: string;
  /** ERC-721 / ERC-1155 token id; null for ERC-20. */
  tokenId: string | null;
  /** Tokens moved: 1 for ERC-721, the count for ERC-1155, whole tokens (decimals applied) for ERC-20. */
  amount: number;
  /** The transaction's sender, target and ETH value (wei); null until looked up (never for ERC-20). */
  txFrom: string | null;
  txTo: string | null;
  txValue: string | null;
};

export type WalletInfo = {
  contract: boolean | null;
  /** Who first sent it ETH, and when. */
  funder: string | null;
  fundedAt: number | null;
  /** The last transaction or token transfer it sent. */
  lastOutAt: number | null;
};

/** One delegation a wallet made as the cold side: delegate.xyz v2 / v1 or warm.xyz. */
export type Delegation = { src: "v2" | "v1" | "warm"; type: number; to: string; contract: string | null };

/** Transactions a holder signed, split at when it first got one of the project's core tokens (Etherscan). */
export type Usage = {
  before: number;
  after: number;
  after_other: number;
  first_sent: number | null;
  last_before: number | null;
  last_other: number | null;
  other_contracts: number;
};

export type Input = {
  project: Project;
  transfers: Transfer[];
  wallets: Map<string, WalletInfo>;
  delegations: Map<string, Delegation[]>;
  ens?: Map<string, string>;
  opensea?: Map<string, string>;
  usage?: Map<string, Usage>;
  /** Optional wallet -> email: adds an email column and a shared_email link. Never put in the summary. */
  emails?: Map<string, string>;
  /** Wallet pairs ("a|b", a < b) someone marked as not the same person: never put in one group. */
  unlinks?: Set<string>;
  /** unix seconds ages are measured from (default: the latest activity seen). */
  now?: number;
};

// Thresholds (days since the wallet last did anything we can see).
export const ACTIVE_DAYS = 90;
export const DORMANT_DAYS = 365;
// Related wallets: evidence scores per wallet pair; pairs scoring MERGE or more join a group.
export const MERGE = 2.0;
export const SCORE = { shared_email: 3, delegation: 3, operator: 3, mint_for: 3, funded_by_holder: 2, free_transfer: 1.5, shared_funder: 1.5, same_block: 1 } as const;
type Evidence = keyof typeof SCORE;
/** A first funder of more of the project's wallets than this is an exchange or service, not one person. */
export const SMALL_FUNDER = 5;
/** Distinct blocks two wallets must both act in before it counts. */
export const SAME_BLOCK_MIN = 3;
/** Bump when the analysis adds or changes columns: stored reports from an older version are redone on the next cron. */
export const ANALYSIS_VERSION = 2;
/** The page lists this many largest holders. */
export const TOP_N = 200;

const ZERO = "0x0000000000000000000000000000000000000000";
const BURN = new Set([ZERO, "0x000000000000000000000000000000000000dead"]);
const DAY = 86400;

export type Row = Record<string, string | number | boolean | null>;
export type Edge = [string, string, number, string];

/** What one transaction did to one wallet in one core collection, for the activity feed. */
export type Activity = {
  at: number;
  coll: string;
  wallet: string;
  kind: "minted" | "bought" | "sold" | "received" | "sent" | "burned";
  amount: number;
  tx: string;
  /** ETH paid in the transaction for these tokens (sales only). */
  eth: number;
  /** The wallet's core total went from nothing to something (new / returned) or to nothing (exited). */
  flag: "new" | "returned" | "exited" | "";
};
/** The activity feed keeps this many days, and at most this many entries (newest). */
export const ACTIVITY_DAYS = 365;
export const ACTIVITY_MAX = 20_000;

export type Report = {
  /** One row per wallet holding any core collection, largest first. */
  holders: Row[];
  /** When each holder first got a core token (unix seconds). */
  firstAt: Map<string, number>;
  /** Per non-core collection, its holders. */
  side: Record<string, Row[]>;
  clusters: Row[];
  links: Edge[];
  /** Newest first. */
  activity: Activity[];
  summary: Record<string, unknown>;
};

const date = (ts: number | null | undefined) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "");
const month = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 7);
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

function nextMonth(m: string) {
  let [y, mo] = m.split("-").map(Number);
  if (++mo > 12) (y += 1), (mo = 1);
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}`;
}
/** Every month from `first` through `last`. */
function monthsBetween(first: string, last: string) {
  const out = [first];
  while (out[out.length - 1] < last) out.push(nextMonth(out[out.length - 1]));
  return out;
}

class Counter<K> extends Map<K, number> {
  add(k: K, n = 1) {
    this.set(k, (this.get(k) ?? 0) + n);
  }
  mostCommon() {
    return [...this.entries()].sort((a, b) => b[1] - a[1]);
  }
}
const countText = (c: Counter<string>) => c.mostCommon().map(([k, n]) => `${k}:${n}`).join(" ");

type Kind = "mint" | "burn" | "stake" | "unstake" | "sale" | "transfer";
/** A balance change: (time, block, collection, wallet, held change, staked change, kind). */
type Change = { at: number; block: number; coll: string; wallet: string; dh: number; ds: number; kind: Kind; tx: string; eth: number };

function chainOrder(rows: Transfer[]) {
  return [...rows].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

export function analyze(input: Input): Report {
  const { project } = input;
  const ens = input.ens ?? new Map();
  const osName = input.opensea ?? new Map();
  const usage = input.usage ?? new Map();
  const email = new Map([...(input.emails ?? new Map())].map(([w, e]) => [w, e.trim().toLowerCase()]));
  const core = project.collections.filter((c) => c.core);
  const side = project.collections.filter((c) => !c.core);
  const coreContracts = new Set(core.map((c) => c.contract));
  const staking = new Set(project.collections.flatMap((c) => c.staking));
  const byContract = new Map<string, Transfer[]>();
  for (const t of input.transfers) {
    const list = byContract.get(t.contract);
    if (list) list.push(t);
    else byContract.set(t.contract, [t]);
  }
  const notWallet = (w: string) => BURN.has(w) || staking.has(w);

  // ---- 1. Replay the core collections' transfers -------------------------------------
  const changes: Change[] = [];
  const owner = new Map<string, string>(); // coll:token -> effective owner
  const rawOwner = new Map<string, string>(); // coll:token -> on-chain owner (the staking contract for staked)
  const staked = new Set<string>(); // coll:token while staked
  const lastColl = new Map<string, number>();
  const freeMoves = new Counter<string>();
  const operators = new Set<string>();
  const mintFor = new Set<string>();
  const blockActors = new Map<number, Set<string>>();
  const sales: { at: number; coll: string; eth: number }[] = [];
  const counts = new Map<string, { transfers: number; minted: number; byMonth: Counter<string> }>();
  let latest = 0;

  for (const coll of core) {
    const rows = chainOrder(byContract.get(coll.contract) ?? []);
    const perTx = new Counter<string>();
    for (const r of rows) perTx.add(r.tx);
    const stakes = new Set(coll.staking);
    const count = { transfers: 0, minted: 0, byMonth: new Counter<string>() };
    counts.set(coll.id, count);
    for (const t of rows) {
      const { from: frm, to, at, block } = t;
      latest = Math.max(latest, at);
      const sender = t.txFrom;
      const value = t.txValue ? BigInt(t.txValue) : 0n;
      const price = value > 0n ? Number(value) / 1e18 / perTx.get(t.tx)! : 0;
      const kind: Kind = BURN.has(frm) ? "mint" : BURN.has(to) ? "burn" : stakes.has(to) ? "stake" : stakes.has(frm) ? "unstake" : value > 0n ? "sale" : "transfer";
      const key = `${coll.id}:${t.tokenId}`;
      const nft = coll.standard === "erc721";
      count.transfers++;
      count.byMonth.add(month(at));
      if (kind === "mint") count.minted += t.amount;
      const prev = owner.get(key);
      if (nft) rawOwner.set(key, to);
      const change = (wallet: string, dh: number, ds: number) => changes.push({ at, block, coll: coll.id, wallet, dh, ds, kind, tx: t.tx, eth: kind === "sale" ? price : 0 });

      if (kind === "mint") {
        if (nft) owner.set(key, to);
        change(to, t.amount, 0);
        if (sender && sender !== to) mintFor.add(`${sender}|${to}`);
      } else if (kind === "burn") {
        // A staked token burned from the staking contract leaves its staker.
        const wasStaked = staked.has(key) && prev !== undefined;
        change(wasStaked ? prev! : frm, wasStaked ? 0 : -t.amount, wasStaked ? -1 : 0);
        owner.delete(key);
        staked.delete(key);
      } else if (kind === "stake") {
        staked.add(key);
        owner.set(key, frm);
        change(frm, -1, 1);
      } else if (kind === "unstake") {
        const staker = prev ?? to;
        staked.delete(key);
        if (to === staker) change(to, 1, -1);
        else {
          // Unstaked straight to someone else: the staker loses a staked token, they gain a held one.
          change(staker, 0, -1);
          change(to, 1, 0);
        }
        owner.set(key, to);
      } else {
        if (nft) owner.set(key, to);
        change(frm, -t.amount, 0);
        change(to, t.amount, 0);
        if (kind === "sale") sales.push({ at, coll: coll.id, eth: price });
        if (sender && value === 0n && t.txTo === coll.contract && sender === frm) freeMoves.add([frm, to].sort().join("|"));
        if (sender && t.txTo === coll.contract && sender !== frm) operators.add(`${sender}|${frm}`);
      }
      for (const w of [frm, to]) if (!BURN.has(w) && !stakes.has(w)) lastColl.set(w, Math.max(lastColl.get(w) ?? 0, at));
      if (sender && kind !== "mint") {
        let s = blockActors.get(block);
        if (!s) blockActors.set(block, (s = new Set()));
        s.add(sender);
      }
    }
  }
  // Stable, like Python's sort: same-time changes keep collection then chain order.
  changes.sort((a, b) => a.at - b.at || a.block - b.block);
  for (const v of input.wallets.values()) latest = Math.max(latest, v.lastOutAt ?? 0, v.fundedAt ?? 0);
  const NOW = input.now ?? (latest || Date.now() / 1000);

  // ---- 2. Balances over time -----------------------------------------------------------
  const bal = new Map<string, [number, number]>(); // coll|wallet -> [held, staked]
  const firstAcq = new Map<string, number>();
  const lastAcq = new Map<string, number>();
  const seriesAt = new Map<string, Map<string, { holders: number; staked: number; tokens: number; top10: number }>>(); // month -> coll -> point
  const snapshot = () => {
    const per = new Map<string, number[]>();
    const st = new Map<string, number>();
    for (const [k, [h, s]] of bal) {
      if (!h && !s) continue;
      const c = k.slice(0, k.indexOf("|"));
      (per.get(c) ?? per.set(c, []).get(c)!).push(h + s);
      st.set(c, (st.get(c) ?? 0) + s);
    }
    return new Map(
      core.map((c) => {
        const tot = (per.get(c.id) ?? []).sort((a, b) => b - a);
        return [c.id, { holders: tot.length, staked: st.get(c.id) ?? 0, tokens: round(sum(tot), 6), top10: round(sum(tot.slice(0, 10)), 6) }];
      }),
    );
  };
  // Activity: changes grouped per transaction and collection, judged per wallet on its core total.
  const total = new Map<string, number>(); // wallet -> held + staked across core collections
  const everHeld = new Set<string>();
  const flows = new Map<string, [number, number]>(); // coll|wallet -> [tokens in, tokens out], netted per transaction
  const activity: Activity[] = [];
  type Group = { key: string; at: number; coll: string; tx: string; per: Map<string, { before: number; net: number; kinds: Set<Kind>; eth: number }> };
  let group = null as Group | null;
  const flush = () => {
    if (!group) return;
    for (const [wallet, g] of group.per) {
      const after = total.get(wallet) ?? 0;
      const moved = round(g.net, 9);
      if (moved) {
        const k = `${group.coll}|${wallet}`;
        const f = flows.get(k) ?? flows.set(k, [0, 0]).get(k)!;
        f[moved > 0 ? 0 : 1] += Math.abs(moved);
      }
      const has = (k: Kind) => g.kinds.has(k);
      let kind: Activity["kind"] | null = null;
      if (moved > 0) kind = has("mint") ? "minted" : has("sale") ? "bought" : "received";
      else if (moved < 0) kind = has("burn") ? "burned" : has("sale") ? "sold" : "sent";
      const flag = g.before <= 1e-9 && after > 1e-9 ? (everHeld.has(wallet) ? "returned" : "new") : g.before > 1e-9 && after <= 1e-9 ? "exited" : "";
      if (after > 1e-9) everHeld.add(wallet);
      if (kind) activity.push({ at: group.at, coll: group.coll, wallet, kind, amount: Math.abs(moved), tx: group.tx, eth: round(g.eth, 6), flag });
    }
    group = null;
  };
  let curMonth: string | null = null;
  for (const e of changes) {
    const gk = `${e.tx}|${e.coll}`;
    if ((group as Group | null)?.key !== gk) {
      flush();
      group = { key: gk, at: e.at, coll: e.coll, tx: e.tx, per: new Map() };
    }
    if (!notWallet(e.wallet)) {
      let g = group!.per.get(e.wallet);
      if (!g) group!.per.set(e.wallet, (g = { before: total.get(e.wallet) ?? 0, net: 0, kinds: new Set(), eth: 0 }));
      g.net += e.dh + e.ds;
      g.kinds.add(e.kind);
      g.eth += e.eth;
      total.set(e.wallet, (total.get(e.wallet) ?? 0) + e.dh + e.ds);
    }
    const m = month(e.at);
    if (curMonth && m !== curMonth) seriesAt.set(curMonth, snapshot());
    curMonth = m;
    const k = `${e.coll}|${e.wallet}`;
    let b = bal.get(k);
    if (!b) bal.set(k, (b = [0, 0]));
    b[0] += e.dh;
    b[1] += e.ds;
    if (e.dh > 0 || e.ds > 0) if (!firstAcq.has(k)) firstAcq.set(k, e.at);
    if (e.dh > 0 && e.kind !== "stake" && !(e.kind === "unstake" && e.ds < 0)) lastAcq.set(k, e.at);
  }
  flush();
  if (curMonth) seriesAt.set(curMonth, snapshot());
  const months = seriesAt.size ? monthsBetween([...seriesAt.keys()].sort()[0], month(NOW)) : [];

  const current = new Map<string, [number, number]>(); // coll|wallet, only non-zero
  for (const [k, v] of bal) if (v[0] || v[1]) current.set(k, [round(v[0], 9), round(v[1], 9)]);
  const cur = (coll: string, w: string) => current.get(`${coll}|${w}`) ?? [0, 0];
  const holderSet = new Set([...current.keys()].map((k) => k.slice(k.indexOf("|") + 1)));
  const holders = [...holderSet].sort();
  const ever = new Set([...bal.keys()].map((k) => k.slice(k.indexOf("|") + 1)));
  for (const w of ever) if (notWallet(w)) ever.delete(w);

  // ---- 2b. Non-core collections: balances on their own, never part of "total" ------------
  const sideState = side.map((coll) => sideReplay(coll, byContract.get(coll.contract) ?? [], NOW));
  const sideOf = new Map(side.map((c, i) => [c.id, sideState[i]]));

  // ---- 3. Delegations ------------------------------------------------------------------
  const delegated = new Map<string, Set<string>>();
  for (const [w, list] of input.delegations) {
    const out = new Set<string>();
    for (const d of list) if (d.src === "warm" || d.type === 1 || (d.contract && coreContracts.has(d.contract))) out.add(d.to);
    out.delete(w);
    out.delete(ZERO);
    delegated.set(w, out);
  }

  // ---- 4. Active / quiet / parked / dormant ---------------------------------------------
  const days = (ts: number) => (ts ? (NOW - ts) / DAY : null);
  const outlook = (lastWeb3: number) => {
    if (!lastWeb3) return "club_only";
    const age = (NOW - lastWeb3) / DAY;
    return age <= 365 ? "alive" : age <= 730 ? "quiet_1_2y" : "gone_2y";
  };
  const useCols = (w: string): Row => {
    const u = usage.get(w);
    if (!u) return { used_before: "", txs_before: "", first_tx: "", used_after: "", txs_after_other: "", txs_after_project: "", last_other_tx: "", other_contracts: "", outlook: "" };
    const lastWeb3 = Math.max(u.last_other ?? 0, u.last_before ?? 0);
    return {
      used_before: u.before ? "yes" : "no",
      txs_before: u.before,
      first_tx: date(u.first_sent),
      used_after: u.after_other ? "yes" : "no",
      txs_after_other: u.after_other,
      txs_after_project: u.after - u.after_other,
      last_other_tx: date(lastWeb3),
      other_contracts: u.other_contracts,
      outlook: outlook(lastWeb3),
    };
  };

  const statusOf = new Map<string, string>();
  const rows: Row[] = [];
  const firstAt = new Map<string, number>();
  for (const w of holders) {
    const info = input.wallets.get(w);
    const lastOut = info?.lastOutAt ?? 0;
    const lastAny = Math.max(lastOut, lastColl.get(w) ?? 0);
    const age = days(lastAny);
    const isStaked = core.some((c) => cur(c.id, w)[1] > 0);
    const hasDele = !!delegated.get(w)?.size;
    const status =
      age === null ? "unknown" : age <= ACTIVE_DAYS ? "active" : age <= DORMANT_DAYS ? "quiet" : isStaked || hasDele ? "parked" : `dormant_${Math.min(4, Math.floor(age / 365))}y`;
    statusOf.set(w, status);
    const gotLast = Math.max(0, ...core.map((c) => lastAcq.get(`${c.id}|${w}`) ?? 0));
    const firsts = core.map((c) => firstAcq.get(`${c.id}|${w}`)).filter((x): x is number => x !== undefined);
    if (firsts.length) firstAt.set(w, Math.min(...firsts));
    const row: Row = { wallet: w, ens: ens.get(w) ?? "", opensea_username: osName.get(w) ?? "" };
    if (input.emails) row.email = email.get(w) ?? "";
    let total = 0;
    let tin = 0;
    let tout = 0;
    for (const c of core) {
      const [h, s] = cur(c.id, w);
      row[`${c.id}_held`] = h;
      if (c.staking.length) row[`${c.id}_staked`] = s;
      total += h + s;
      const [i, o] = flows.get(`${c.id}|${w}`) ?? [0, 0];
      tin += i;
      tout += o;
    }
    row.total = round(total, 9);
    // Everything it ever got (mints, buys, transfers in) and let go of; staking moves don't count.
    row.tokens_in = round(tin, 9);
    row.tokens_out = round(tout, 9);
    for (const c of side) row[c.id] = sideOf.get(c.id)!.held(w);
    Object.assign(row, {
      status,
      days_since_activity: age === null ? "" : round(age, 1),
      last_activity: date(lastAny),
      last_outgoing_tx: date(lastOut),
      last_collection_move: date(lastColl.get(w)),
      first_acquired: date(firsts.length ? Math.min(...firsts) : 0),
      ...useCols(w),
      last_acquired: date(gotLast),
      is_contract: info?.contract ?? "",
      delegates_to: [...(delegated.get(w) ?? [])].sort().join(" "),
      first_funder: info?.funder ?? "",
      funded_on: date(info?.fundedAt),
    });
    rows.push(row);
  }

  // ---- 5. Related wallets ----------------------------------------------------------------
  const pairEv = new Map<string, [Evidence, number][]>();
  const add = (a: string, b: string, kind: Evidence, n = 1) => {
    if (a === b || notWallet(a) || notWallet(b)) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    (pairEv.get(k) ?? pairEv.set(k, []).get(k)!).push([kind, n]);
  };
  for (const [cold, hots] of delegated) for (const hot of hots) add(cold, hot, "delegation");
  const byEmail = new Map<string, string[]>();
  for (const [w, e] of email) if (e && e.includes("@") && !e.startsWith("xxx@")) (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(w);
  for (const ws of byEmail.values()) pairs(ws, (a, b) => add(a, b, "shared_email"));
  for (const p of operators) add(...(p.split("|") as [string, string]), "operator");
  for (const p of mintFor) add(...(p.split("|") as [string, string]), "mint_for");
  for (const [p, n] of freeMoves) add(...(p.split("|") as [string, string]), "free_transfer", n);
  const funders = new Map<string, Set<string>>();
  for (const w of ever) {
    const f = input.wallets.get(w)?.funder;
    if (f) (funders.get(f) ?? funders.set(f, new Set()).get(f)!).add(w);
  }
  for (const [f, ws] of funders) {
    // A holder that funds many wallets is an exchange or service, not one person.
    if (ever.has(f) && ws.size <= SMALL_FUNDER) for (const w of ws) add(f, w, "funded_by_holder");
    if (ws.size >= 2 && ws.size <= SMALL_FUNDER) pairs([...ws].sort(), (a, b) => add(a, b, "shared_funder"));
  }
  const co = new Counter<string>();
  for (const ws of blockActors.values()) {
    const inEver = [...ws].filter((w) => ever.has(w)).sort();
    if (inEver.length >= 2 && inEver.length <= 6) pairs(inEver, (a, b) => co.add(`${a}|${b}`));
  }
  for (const [p, n] of co) if (n >= SAME_BLOCK_MIN) add(...(p.split("|") as [string, string]), "same_block", n);

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const links: Edge[] = [];
  const merges: [string, string, number][] = [];
  for (const [k, ev] of pairEv) {
    const [a, b] = k.split("|");
    let s = 0;
    const kinds = new Counter<string>();
    for (const [kind, n] of ev) {
      s += kind === "free_transfer" ? SCORE[kind] * Math.min(n, 3) : SCORE[kind];
      kinds.add(kind, n);
    }
    links.push([a, b, round(s, 2), [...kinds.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([kk, n]) => `${kk}:${n}`).join(" ")]);
    if (s >= MERGE) merges.push([a, b, s]);
  }
  // Join pairs into groups, strongest evidence first, never joining two groups that would put a
  // pair marked "not related" together (so a marked wallet stays out even through a third wallet).
  const unlinks = input.unlinks ?? new Set<string>();
  const apart = new Map<string, Set<string>>();
  for (const k of unlinks) {
    const [a, b] = k.split("|");
    (apart.get(a) ?? apart.set(a, new Set()).get(a)!).add(b);
    (apart.get(b) ?? apart.set(b, new Set()).get(b)!).add(a);
  }
  const comp = new Map<string, string[]>(); // root -> members, once it has more than one
  merges.sort((x, y) => y[2] - x[2]);
  for (const [a, b] of merges) {
    if (unlinks.has(`${a}|${b}`)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    const ma = comp.get(ra) ?? [ra];
    const mb = comp.get(rb) ?? [rb];
    if (apart.size) {
      const [few, other] = ma.length < mb.length ? [ma, rb] : [mb, ra];
      if (few.some((m) => [...(apart.get(m) ?? [])].some((u) => parent.has(u) && find(u) === other))) continue;
    }
    parent.set(ra, rb);
    comp.set(rb, ma.concat(mb));
    comp.delete(ra);
  }
  const members = new Map<string, string[]>();
  for (const w of parent.keys()) {
    const r = find(w);
    (members.get(r) ?? members.set(r, []).get(r)!).push(w);
  }
  const clusterTokens = (ms: string[]) => core.flatMap((c) => [sum(ms.map((m) => cur(c.id, m)[0])), sum(ms.map((m) => cur(c.id, m)[1]))]);
  const groups = [...members.values()]
    .filter((ms) => ms.length > 1 && ms.some((m) => holderSet.has(m)))
    .map((ms) => ms.sort())
    .map((ms) => ({ ms, tokens: clusterTokens(ms) }))
    .sort((a, b) => sum(b.tokens) - sum(a.tokens));
  const clusterOf = new Map<string, string>();
  groups.forEach((g, i) => g.ms.forEach((m) => clusterOf.set(m, `C${String(i + 1).padStart(4, "0")}`)));
  const why = new Map<string, Counter<string>>();
  for (const [a, b, s, evidence] of links) {
    const ca = clusterOf.get(a);
    if (s < MERGE || !ca || ca !== clusterOf.get(b)) continue;
    const c = why.get(ca) ?? why.set(ca, new Counter()).get(ca)!;
    for (const part of evidence.split(" ")) c.add(part.split(":")[0]);
  }
  const clusters: Row[] = groups.map(({ ms, tokens }, i) => {
    const cid = `C${String(i + 1).padStart(4, "0")}`;
    const row: Row = { cluster: cid, wallets: ms.length, holding_wallets: ms.filter((m) => holderSet.has(m)).length };
    core.forEach((c, j) => {
      row[`${c.id}_held`] = round(tokens[2 * j], 9);
      if (c.staking.length) row[`${c.id}_staked`] = tokens[2 * j + 1];
    });
    const statuses = new Counter<string>();
    for (const m of ms) statuses.add(statusOf.get(m) ?? "past");
    Object.assign(row, {
      total: round(sum(tokens), 9),
      statuses: countText(statuses),
      evidence: countText(why.get(cid) ?? new Counter()),
      names: ms.map((m) => ens.get(m) || osName.get(m)).filter(Boolean).join(" "),
    });
    if (input.emails) row.emails = [...new Set(ms.map((m) => email.get(m)).filter(Boolean))].sort().join(" ");
    row.members = ms.join(" ");
    return row;
  });
  for (const r of rows) r.cluster = clusterOf.get(r.wallet as string) ?? "";

  // Largest first; ties go to more of the first core collection.
  const first = core[0];
  const firstOf = (r: Row) => Number(r[`${first.id}_held`] ?? 0) + Number(r[`${first.id}_staked`] ?? 0);
  rows.sort((a, b) => Number(b.total) - Number(a.total) || firstOf(b) - firstOf(a) || (a.wallet! < b.wallet! ? -1 : 1));
  links.sort((a, b) => b[2] - a[2]);

  // ---- 6. Non-core holder lists ----------------------------------------------------------
  const byWallet = new Map(rows.map((r) => [r.wallet as string, r]));
  const sideRows: Record<string, Row[]> = {};
  for (const c of side) {
    const st = sideOf.get(c.id)!;
    sideRows[c.id] = [...st.current.keys()]
      .map((w) => {
        const row: Row = { wallet: w, ens: ens.get(w) ?? "", opensea_username: osName.get(w) ?? "" };
        if (input.emails) row.email = email.get(w) ?? "";
        row[c.id] = st.held(w);
        if (c.standard === "erc1155") for (const id of st.types) row[`${c.id}_${id}`] = st.current.get(w)!.get(id) ?? 0;
        row.is_contract = input.wallets.get(w)?.contract ?? "";
        row.core_total = byWallet.get(w)?.total ?? 0;
        for (const o of side) if (o !== c) row[o.id] = sideOf.get(o.id)!.held(w);
        row.status = statusOf.get(w) ?? "";
        return row;
      })
      .sort((a, b) => Number(b[c.id]) - Number(a[c.id]) || (a.wallet! < b.wallet! ? -1 : 1));
  }

  // ---- 7. Summary for the page (no emails) -----------------------------------------------
  const buckets = (c: Collection, values: number[]) => {
    const names = c.standard === "erc20" ? ["under 100", "100-1k", "1k-10k", "10k-100k", "100k+"] : ["1", "2-4", "5-9", "10-24", "25+"];
    const pick =
      c.standard === "erc20"
        ? (n: number) => (n < 100 ? 0 : n < 1e3 ? 1 : n < 1e4 ? 2 : n < 1e5 ? 3 : 4)
        : (n: number) => (n <= 1 ? 0 : n < 5 ? 1 : n < 10 ? 2 : n < 25 ? 3 : 4);
    const out: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
    for (const v of values) out[names[pick(v)]]++;
    return out;
  };
  const vol = new Map<string, Map<string, [number, number]>>();
  for (const s of sales) {
    const m = vol.get(s.coll) ?? vol.set(s.coll, new Map()).get(s.coll)!;
    const v = m.get(month(s.at)) ?? [0, 0];
    m.set(month(s.at), [v[0] + 1, v[1] + s.eth]);
  }
  const lastPoint = new Map<string, { holders: number; staked: number; tokens: number; top10: number }>();
  const strip = (r: Row) => {
    const { email: _e, emails: _es, ...rest } = r;
    return input.emails ? { ...rest, has_email: !!r.email } : rest;
  };
  const multi = holders.filter((w) => core.filter((c) => current.has(`${c.id}|${w}`)).length >= 2);
  const withUsage = rows.filter((r) => r.used_before);
  const statusCounts = new Counter<string>();
  for (const s of statusOf.values()) statusCounts.add(s);
  const summary: Record<string, unknown> = {
    version: ANALYSIS_VERSION,
    project: { id: project.id, name: project.name },
    generated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    as_of: date(NOW),
    thresholds: { active_days: ACTIVE_DAYS, dormant_days: DORMANT_DAYS, merge_score: MERGE, scores: SCORE, small_funder: SMALL_FUNDER },
    collections: Object.fromEntries(
      core.map((c) => {
        const cc = counts.get(c.id)!;
        const holding = [...current].filter(([k]) => k.startsWith(`${c.id}|`));
        const status = { wallets: {} as Record<string, number>, tokens: {} as Record<string, number> };
        for (const [k, [h, s]] of holding) {
          const st = statusOf.get(k.slice(k.indexOf("|") + 1))!;
          status.wallets[st] = (status.wallets[st] ?? 0) + 1;
          status.tokens[st] = round((status.tokens[st] ?? 0) + h + s, 6);
        }
        return [
          c.id,
          {
            name: c.name,
            short: c.short,
            contract: c.contract,
            standard: c.standard,
            transfers: cc.transfers,
            minted: cc.minted,
            holders_now: holding.length,
            owners_onchain: c.standard === "erc721" ? new Set([...rawOwner].filter(([k, o]) => k.startsWith(`${c.id}:`) && !BURN.has(o)).map(([, o]) => o)).size : holding.length,
            staked_now: sum(holding.map(([, [, s]]) => s)),
            series: months.map((m) => {
              const p = seriesAt.get(m)?.get(c.id) ?? lastPoint.get(c.id) ?? { holders: 0, staked: 0, tokens: 0, top10: 0 };
              lastPoint.set(c.id, p);
              return { month: m, ...p };
            }),
            buckets: buckets(c, holding.map(([, [h, s]]) => h + s)),
            status,
            volume: [...(vol.get(c.id) ?? new Map())].sort().map(([m, [n, eth]]) => ({ month: m, sales: n, eth: round(eth, 3) })),
            transfers_by_month: [...cc.byMonth].sort().map(([m, n]) => ({ month: m, n })),
          },
        ];
      }),
    ),
    side: Object.fromEntries(
      side.map((c) => {
        const st = sideOf.get(c.id)!;
        const values = [...st.current.keys()].map((w) => st.held(w));
        const coreHolders = [...st.current.keys()].filter((w) => holderSet.has(w));
        return [
          c.id,
          {
            name: c.name,
            short: c.short,
            contract: c.contract,
            standard: c.standard,
            transfers: st.transfers,
            holders_now: st.current.size,
            supply: round(sum(values), 4),
            minted: round(sum([...st.minted.values()]), 4),
            burned: round(sum([...st.burned.values()]), 4),
            also_hold_core: coreHolders.length,
            held_by_core_holders: round(sum(coreHolders.map((w) => st.held(w))), 4),
            types:
              c.standard === "erc1155"
                ? st.types.map((id) => ({
                    id,
                    name: c.tokenNames[id] ?? `#${id}`,
                    holders: [...st.current.values()].filter((m) => (m.get(id) ?? 0) > 0).length,
                    tokens: sum([...st.current.values()].map((m) => m.get(id) ?? 0)),
                    minted: st.minted.get(id) ?? 0,
                    burned: st.burned.get(id) ?? 0,
                  }))
                : undefined,
            series: st.series,
            buckets: buckets(c, values),
            top: sideRows[c.id].slice(0, 25).map(strip),
          },
        ];
      }),
    ),
    usage: withUsage.length
      ? {
          checked: withUsage.length,
          contracts: withUsage.filter((r) => r.is_contract === true).length,
          combos: Object.fromEntries(
            (
              [
                ["before_and_after", "yes", "yes"],
                ["before_only", "yes", "no"],
                ["after_only", "no", "yes"],
                ["neither", "no", "no"],
              ] as const
            ).map(([k, b, a]) => {
              const g = withUsage.filter((r) => r.used_before === b && r.used_after === a);
              return [k, { wallets: g.length, tokens: round(sum(g.map((r) => Number(r.total))), 6) }];
            }),
          ),
          outlook: Object.fromEntries(
            (
              [
                ["small", withUsage.filter((r) => Number(r.total) <= 4)],
                ["large", withUsage.filter((r) => Number(r.total) >= 5)],
              ] as const
            ).map(([size, grp]) => [
              size,
              Object.fromEntries(
                ["alive", "quiet_1_2y", "gone_2y", "club_only"].map((o) => {
                  const g = grp.filter((r) => r.outlook === o);
                  return [
                    o,
                    {
                      wallets: g.length,
                      tokens: round(sum(g.map((r) => Number(r.total))), 6),
                      parked: g.filter((r) => r.status === "parked").length,
                      project_active: g.filter((r) => r.status === "active" || r.status === "quiet").length,
                    },
                  ];
                }),
              ),
            ]),
          ),
        }
      : null,
    holders_total: holders.length,
    holders_multi: multi.length,
    checked: { wallets: holders.filter((w) => input.wallets.has(w)).length, delegations: holders.filter((w) => input.delegations.has(w)).length },
    named: {
      ens: holders.filter((w) => ens.get(w)).length,
      opensea: holders.filter((w) => osName.get(w)).length,
      either: holders.filter((w) => ens.get(w) || osName.get(w)).length,
    },
    status_all: Object.fromEntries(statusCounts.mostCommon()),
    clusters: { count: clusters.length, wallets: sum(clusters.map((r) => Number(r.wallets))), top: clusters.slice(0, 25).map(strip) },
    top_holders: rows.slice(0, TOP_N).map(strip),
  };
  const recent = activity.filter((a) => a.at >= NOW - ACTIVITY_DAYS * DAY).reverse().slice(0, ACTIVITY_MAX);
  const tally = (days: number) => {
    const c: Record<string, number> = { new: 0, returned: 0, exited: 0, minted: 0, bought: 0, sold: 0, received: 0, sent: 0, burned: 0 };
    for (const a of recent) {
      if (a.at < NOW - days * DAY) break;
      c[a.kind]++;
      if (a.flag) c[a.flag]++;
    }
    return c;
  };
  summary.activity = { d7: tally(7), d30: tally(30) };
  return { holders: rows, firstAt, side: sideRows, clusters, links, activity: recent, summary };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
function pairs(xs: string[], fn: (a: string, b: string) => void) {
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) fn(xs[i], xs[j]);
}

/** A non-core collection: plain balances per wallet (and per token id for ERC-1155), month by month. */
function sideReplay(coll: Collection, transfers: Transfer[], now: number) {
  const bal = new Map<string, Map<string, number>>(); // wallet -> token id ("" for ERC-20) -> amount
  const minted = new Counter<string>();
  const burned = new Counter<string>();
  const types = new Set<string>();
  const snaps = new Map<string, { holders: number; tokens: number; top10: number }>();
  const snap = () => {
    const tot = [...bal.values()].map((m) => sum([...m.values()])).filter((n) => n > 1e-9).sort((a, b) => b - a);
    return { holders: tot.length, tokens: round(sum(tot), 4), top10: round(sum(tot.slice(0, 10)), 4) };
  };
  let curMonth: string | null = null;
  const rows = chainOrder(transfers);
  for (const t of rows) {
    const m = month(t.at);
    if (curMonth && m !== curMonth) snaps.set(curMonth, snap());
    curMonth = m;
    const id = t.tokenId ?? "";
    if (coll.standard === "erc1155") types.add(id);
    if (BURN.has(t.from)) minted.add(id, t.amount);
    if (BURN.has(t.to)) burned.add(id, t.amount);
    for (const [w, sign] of [
      [t.from, -1],
      [t.to, 1],
    ] as const) {
      if (BURN.has(w)) continue;
      const key = coll.standard === "erc721" ? "" : id;
      const mm = bal.get(w) ?? bal.set(w, new Map()).get(w)!;
      mm.set(key, (mm.get(key) ?? 0) + sign * t.amount);
    }
  }
  if (curMonth) snaps.set(curMonth, snap());
  const current = new Map<string, Map<string, number>>();
  for (const [w, m] of bal) if (sum([...m.values()]) > 1e-9) current.set(w, m);
  const series: { month: string; holders: number; tokens: number; top10: number }[] = [];
  if (snaps.size) {
    let last = { holders: 0, tokens: 0, top10: 0 };
    for (const m of monthsBetween([...snaps.keys()].sort()[0], month(now))) series.push({ month: m, ...(last = snaps.get(m) ?? last) });
  }
  return {
    transfers: rows.length,
    current,
    held: (w: string) => round(sum([...(current.get(w)?.values() ?? [])]), 4),
    minted,
    burned,
    types: [...types].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
    series,
  };
}
