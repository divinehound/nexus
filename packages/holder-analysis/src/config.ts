// The shape of a holder analysis project and its collections, and the checks on them. Ported
// from the holder analysis Worker (spooky-bar apps/holder-analysis/src/config.ts, 2026-10-28)
// without its D1 storage: in Nexus a project's collections come from the projects and
// collections tables plus holder_analysis_collection_settings. Addresses are lowercased here
// and everywhere after.

export type Standard = "erc721" | "erc1155" | "erc20";

export type Collection = {
  /** Short id, unique within its project: used in CSV columns ("sb_held") and URLs. */
  id: string;
  name: string;
  short: string;
  contract: string;
  standard: Standard;
  /** Core collections make up a holder's "total" and decide who counts as a holder (status, related groups). */
  core: boolean;
  /** ERC-20 decimals (18 unless set); 0 for NFTs. */
  decimals: number;
  /** ERC-721 staking contracts: tokens sent there still count for whoever staked them, marked staked. */
  staking: string[];
  /** Names for ERC-1155 token ids, e.g. { "420": "Gold Key" }. */
  tokenNames: Record<string, string>;
};

export type Project = { id: string; name: string; collections: Collection[] };

const ADDR = /^0x[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Checks and fills in projects as saved on the website; throws on anything that would make a run go wrong quietly. */
export function parseProjects(input: unknown): Project[] {
  const list = (input as { projects?: unknown[] })?.projects;
  if (!Array.isArray(list) || !list.length) throw new Error("no projects");
  const ids = new Set<string>();
  return list.map((p: any, i) => {
    const where = `Project ${p?.id ?? i}`;
    if (!ID.test(p?.id ?? "")) throw new Error(`${where}: id must be lowercase letters, digits or dashes`);
    if (ids.has(p.id)) throw new Error(`${where}: duplicate id`);
    ids.add(p.id);
    if (!Array.isArray(p.collections) || !p.collections.length) throw new Error(`${where}: no collections`);
    const cids = new Set<string>();
    const collections: Collection[] = p.collections.map((c: any) => {
      const at = `${where}, collection ${c?.id || "(no id)"}`;
      if (!ID.test(c?.id ?? "") || c.id.includes("-")) throw new Error(`${at}: id must be lowercase letters or digits`);
      if (cids.has(c.id)) throw new Error(`${at}: duplicate id`);
      cids.add(c.id);
      const contract = String(c.contract ?? "").toLowerCase();
      if (!ADDR.test(contract)) throw new Error(`${at}: contract isn't an address`);
      if (!["erc721", "erc1155", "erc20"].includes(c.standard)) throw new Error(`${at}: standard must be erc721, erc1155 or erc20`);
      const staking = (c.staking ?? []).map((s: string) => String(s).toLowerCase());
      if (staking.some((s: string) => !ADDR.test(s))) throw new Error(`${at}: staking must be addresses`);
      if (staking.length && c.standard !== "erc721") throw new Error(`${at}: staking is only followed for erc721`);
      return {
        id: c.id,
        name: String(c.name ?? c.id),
        short: String(c.short ?? c.name ?? c.id),
        contract,
        standard: c.standard,
        core: c.core ?? c.standard === "erc721",
        decimals: c.standard === "erc20" ? Number(c.decimals ?? 18) : 0,
        staking,
        tokenNames: c.tokenNames ?? {},
      };
    });
    // A project with no core collection (say, one ERC-20) treats them all as core.
    if (!collections.some((c) => c.core)) for (const c of collections) c.core = true;
    return { id: p.id, name: String(p.name ?? p.id), collections };
  });
}

/** Every contract the job reads, once each, with what the projects say about it. */
export function contractsOf(projects: Project[]): Map<string, { standard: Standard; decimals: number; core: boolean }> {
  const out = new Map<string, { standard: Standard; decimals: number; core: boolean }>();
  for (const p of projects)
    for (const c of p.collections) {
      const seen = out.get(c.contract);
      if (seen && (seen.standard !== c.standard || seen.decimals !== c.decimals)) throw new Error(`${c.contract} is set up two different ways (standard or decimals) in two projects`);
      out.set(c.contract, { standard: c.standard, decimals: c.decimals, core: c.core || !!seen?.core });
    }
  return out;
}

