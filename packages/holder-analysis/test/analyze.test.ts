import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, type Transfer } from "../src/analyze";
import { contractsOf, parseProjects } from "../src/config";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const ZERO = "0x" + "0".repeat(40);
const NFT = "0x" + "1".repeat(40);
const TOKEN = "0x" + "2".repeat(40);
const STAKE = "0x" + "5".repeat(40);
const DAY = 86400;
const NOW = 2_000_000_000;

const [project] = parseProjects({
  projects: [
    {
      id: "demo",
      name: "Demo",
      collections: [
        { id: "nft", name: "Demo NFT", contract: NFT, standard: "erc721", staking: [STAKE] },
        { id: "tok", name: "Demo Token", contract: TOKEN, standard: "erc20", decimals: 18 },
      ],
    },
  ],
});

let n = 0;
const t = (contract: string, from: string, to: string, at: number, extra: Partial<Transfer> = {}): Transfer => ({
  contract,
  block: ++n,
  logIndex: 0,
  at,
  tx: `0x${n.toString(16).padStart(64, "0")}`,
  from,
  to,
  tokenId: contract === NFT ? "1" : null,
  amount: 1,
  txFrom: from === ZERO ? to : from,
  txTo: contract,
  txValue: "0",
  ...extra,
});

test("config: defaults, lowercase, core fallback", () => {
  assert.equal(project.collections[0].core, true);
  assert.equal(project.collections[1].core, false);
  const [p] = parseProjects({ projects: [{ id: "x", collections: [{ id: "t", contract: TOKEN.toUpperCase().replace("0X", "0x"), standard: "erc20" }] }] });
  assert.equal(p.collections[0].core, true);
  assert.equal(p.collections[0].contract, TOKEN);
  assert.throws(() => parseProjects({ projects: [{ id: "x", collections: [{ id: "t", contract: "nope", standard: "erc20" }] }] }));
  assert.equal(contractsOf([project]).size, 2);
});

test("staked tokens count for the staker, who is parked when idle", () => {
  n = 0;
  const transfers = [
    t(NFT, ZERO, A, NOW - 900 * DAY, { tokenId: "1" }),
    t(NFT, A, STAKE, NOW - 800 * DAY, { tokenId: "1" }),
    t(NFT, ZERO, B, NOW - 10 * DAY, { tokenId: "2" }),
    t(TOKEN, ZERO, C, NOW - 5 * DAY, { amount: 150 }),
    t(TOKEN, C, B, NOW - 4 * DAY, { amount: 50 }),
  ];
  const r = analyze({ project, transfers, wallets: new Map(), delegations: new Map(), now: NOW });
  const a = r.holders.find((h) => h.wallet === A)!;
  assert.equal(a.nft_held, 0);
  assert.equal(a.nft_staked, 1);
  assert.equal(a.status, "parked");
  const b = r.holders.find((h) => h.wallet === B)!;
  assert.equal(b.status, "active");
  assert.equal(b.tok, 50);
  assert.equal(r.holders.length, 2, "token-only holders aren't core holders");
  assert.deepEqual(
    r.side.tok.map((h) => [h.wallet, h.tok]),
    [
      [C, 100],
      [B, 50],
    ],
  );
  const s = r.summary as any;
  assert.equal(s.collections.nft.staked_now, 1);
  assert.equal(s.side.tok.holders_now, 2);
});

test("dormant by years, and a delegation joins two wallets into one group", () => {
  n = 0;
  const transfers = [t(NFT, ZERO, A, NOW - 3.5 * 365 * DAY, { tokenId: "1" }), t(NFT, ZERO, B, NOW - 3.5 * 365 * DAY, { tokenId: "2" })];
  const r = analyze({
    project,
    transfers,
    wallets: new Map([[A, { contract: false, funder: null, fundedAt: null, lastOutAt: NOW - 2.2 * 365 * DAY }]]),
    delegations: new Map([[B, [{ src: "v2", type: 1, to: C, contract: null }]]]),
    now: NOW,
  });
  const byWallet = new Map(r.holders.map((h) => [h.wallet, h]));
  assert.equal(byWallet.get(A)!.status, "dormant_2y");
  assert.equal(byWallet.get(B)!.status, "parked", "delegated, so someone still uses it");
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].members, [B, C].sort().join(" "));
  assert.equal(byWallet.get(B)!.cluster, "C0001");
});

test("a sale is counted with its price per token", () => {
  n = 0;
  const transfers = [t(NFT, ZERO, A, NOW - 40 * DAY, { tokenId: "1" }), t(NFT, A, B, NOW - 30 * DAY, { tokenId: "1", txFrom: B, txValue: (5n * 10n ** 17n).toString() })];
  const r = analyze({ project, transfers, wallets: new Map(), delegations: new Map(), now: NOW });
  const vol = (r.summary as any).collections.nft.volume;
  assert.equal(vol.length, 1);
  assert.equal(vol[0].sales, 1);
  assert.equal(vol[0].eth, 0.5);
});

test("activity: mint, stake (quiet), sale, exit and return", () => {
  n = 0;
  const transfers = [
    t(NFT, ZERO, A, NOW - 50 * DAY, { tokenId: "1" }),
    t(NFT, A, STAKE, NOW - 40 * DAY, { tokenId: "1" }),
    t(NFT, STAKE, A, NOW - 30 * DAY, { tokenId: "1" }),
    t(NFT, A, B, NOW - 20 * DAY, { tokenId: "1", txFrom: B, txValue: "500000000000000000" }),
    t(NFT, B, A, NOW - 10 * DAY, { tokenId: "1" }),
  ];
  const r = analyze({ project, transfers, wallets: new Map(), delegations: new Map(), now: NOW });
  const seen = r.activity.map((a) => `${a.wallet === A ? "A" : "B"} ${a.kind} ${a.flag}`.trim());
  assert.deepEqual(seen, ["A received returned", "B sent exited", "B bought new", "A sold exited", "A minted new"]);
  assert.equal(r.activity.find((a) => a.kind === "bought")!.eth, 0.5);
  assert.equal((r.summary.activity as any).d30.sold, 1);
  const rowA = r.holders.find((h) => h.wallet === A)!;
  assert.deepEqual([rowA.tokens_in, rowA.tokens_out], [2, 1]);
});

test("related groups: a pair marked not related stays apart, even through a third wallet", () => {
  n = 0;
  const D = "0x" + "d".repeat(40);
  const transfers = [t(NFT, ZERO, A, NOW - 10 * DAY, { tokenId: "1" }), t(NFT, ZERO, B, NOW - 10 * DAY, { tokenId: "2" }), t(NFT, ZERO, D, NOW - 10 * DAY, { tokenId: "3" })];
  // A delegates to B and to D: one group of three.
  const delegations = new Map([[A, [{ src: "v2" as const, type: 1, to: B, contract: null }, { src: "v2" as const, type: 1, to: D, contract: null }]]]);
  const base = { project, transfers, wallets: new Map(), delegations, now: NOW };
  const groupOf = (r: ReturnType<typeof analyze>, w: string) => r.holders.find((h) => h.wallet === w)!.cluster;
  const r1 = analyze(base);
  assert.equal(groupOf(r1, B), groupOf(r1, D));
  assert.notEqual(groupOf(r1, B), "");
  // B and D are not the same person: A can join only one of them.
  const r2 = analyze({ ...base, unlinks: new Set([[B, D].sort().join("|")]) });
  assert.ok(groupOf(r2, B) !== groupOf(r2, D) || groupOf(r2, B) === "");
  // A taken out of its group entirely.
  const r3 = analyze({ ...base, unlinks: new Set([[A, B].sort().join("|"), [A, D].sort().join("|")]) });
  assert.equal(groupOf(r3, A), "");
});
