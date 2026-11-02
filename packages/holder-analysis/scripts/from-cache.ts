// A regression check, not part of the app: runs src/analyze.ts on the offline SBCC scripts'
// cached chain data (the data/ folder fetch.mjs, spookeys.mjs, soul.mjs, ens.mjs, opensea.mjs
// and usage.mjs wrote) with the SBCC setup in sbcc-project.json, to compare with analyze.py.
//   npx tsx scripts/from-cache.ts <data dir> [out dir]

import fs from "node:fs";
import path from "node:path";
import { analyze, type Delegation, type Input, type Transfer, type Usage, type WalletInfo } from "../src/analyze";
import { parseProjects } from "../src/config";
import sbcc from "./sbcc-project.json";
import { toCsv } from "../src/csv";

const lo = (a: string | null | undefined) => (a ?? "0x0000000000000000000000000000000000000000").toLowerCase();
const NAMES: Record<string, string> = { "spooky-boys": "sb", "mansion-party": "mp", spookeys: "keys", soul: "soul" };

export function loadCache(dir: string) {
  const load = <T,>(f: string, d: T): T => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) : d);
  const [project] = parseProjects(sbcc);
  const txs: Record<string, [string, string, string, string]> = { ...load("txs-extra.json", {}), ...load("txs.json", {}) };
  const transfers: Transfer[] = [];
  for (const [file, id] of Object.entries(NAMES)) {
    const coll = project.collections.find((c) => c.id === id)!;
    for (const r of load<{ rows: any[] }>(`transfers-${file}.json`, { rows: [] }).rows) {
      const [block, ts, hash, uid, from, to, a6, a7] = r;
      const tx = coll.standard === "erc20" ? undefined : txs[hash];
      transfers.push({
        contract: coll.contract,
        block,
        logIndex: Number(String(uid).split(":").pop()) || 0,
        at: ts,
        tx: hash.toLowerCase(),
        from: lo(from),
        to: lo(to),
        tokenId: coll.standard === "erc20" ? null : String(a6),
        amount: coll.standard === "erc721" ? 1 : coll.standard === "erc1155" ? Number(a7) : Number(BigInt(a6) / 10n ** 12n) / 1e6,
        txFrom: tx ? lo(tx[0]) : null,
        txTo: tx ? lo(tx[1]) : null,
        txValue: tx ? String(tx[2]) : null,
      });
    }
  }
  const wallets = new Map<string, WalletInfo>();
  for (const [w, v] of Object.entries<any>(load("wallets.json", {})))
    wallets.set(lo(w), { contract: v.contract, funder: v.funded ? lo(v.funded[2]) : null, fundedAt: v.funded?.[1] ?? null, lastOutAt: v.lastOut?.[1] ?? null });
  const delegations = new Map<string, Delegation[]>();
  for (const [w, d] of Object.entries<any>(load("delegations.json", {}))) {
    const list: Delegation[] = [];
    for (const x of d.getOutgoingDelegations ?? []) list.push({ src: "v2", type: Number(x.type_), to: lo(x.to), contract: x.contract_ ? lo(x.contract_) : null });
    for (const x of d.getDelegationsByVault ?? []) list.push({ src: "v1", type: Number(x.type_), to: lo(x.delegate), contract: x.contract_ ? lo(x.contract_) : null });
    if (typeof d.getHotWallet === "string" && !/^0x0{40}$/i.test(d.getHotWallet)) list.push({ src: "warm", type: 1, to: lo(d.getHotWallet), contract: null });
    delegations.set(lo(w), list);
  }
  const map = (f: string) => new Map(Object.entries<string>(load(f, {})).filter(([, v]) => v).map(([w, v]) => [lo(w), v]));
  const ens = map("ens.json");
  for (const [w, names] of Object.entries<[string, unknown][]>(load("ens_owned.json", {}))) if (names?.length && !ens.get(lo(w))) ens.set(lo(w), names[0][0]);
  const usage = new Map(Object.entries<Usage>(load("usage.json", {})).map(([w, u]) => [lo(w), u]));
  return { project, transfers, wallets, delegations, ens, opensea: map("opensea.json"), usage, emails: map("emails.json") } satisfies Input;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, out = "out"] = process.argv.slice(2);
  const t0 = Date.now();
  const input = loadCache(dir);
  const t1 = Date.now();
  const r = analyze(input);
  console.error(`loaded ${input.transfers.length} transfers in ${t1 - t0} ms, analysed in ${Date.now() - t1} ms`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "holders.csv"), toCsv(r.holders));
  fs.writeFileSync(path.join(out, "clusters.csv"), toCsv(r.clusters));
  fs.writeFileSync(path.join(out, "links.csv"), toCsv(r.links, ["wallet_a", "wallet_b", "score", "evidence"]));
  for (const [id, rows] of Object.entries(r.side)) fs.writeFileSync(path.join(out, `${id}.csv`), toCsv(rows));
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(r.summary, null, 1));
  const s = r.summary as any;
  console.log(JSON.stringify({ holders: s.holders_total, multi: s.holders_multi, status: s.status_all, clusters: s.clusters.count, clusterWallets: s.clusters.wallets }));
}
