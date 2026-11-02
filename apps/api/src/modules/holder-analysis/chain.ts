// Reading an EVM chain through Alchemy for the holder analysis, gently: each run has a budget of
// calls, spaced `gap` ms apart, and a 429 ends the run's chain reads until the next run instead of
// retrying into the limit. Ported from the holder analysis Worker (spooky-bar
// apps/holder-analysis/src/chain.ts) with its Env replaced by ChainEnv, so one run can read any
// Alchemy-supported chain.

import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import type { Delegation, Standard, Usage } from '@nexus/holder-analysis';

/** What a run needs to reach one chain. */
export type ChainEnv = {
  /** Alchemy JSON-RPC URL with key, e.g. https://eth-mainnet.g.alchemy.com/v2/<key>. */
  rpcUrl: string;
  /** EVM chain id, for Etherscan's v2 API. */
  chainId: number;
  /** delegate.xyz, warm.xyz and ENS reverse records: Ethereum mainnet only. */
  mainnet: boolean;
  openseaKey?: string;
  etherscanKey?: string;
  /** Swappable for tests. */
  fetch?: typeof fetch;
};

/** A run's Alchemy allowance: `max` calls, spaced `gap` ms, and done by `until` so runs don't overlap. */
export type Budget = { calls: number; max: number; gap: number; until: number; last?: number; limited?: boolean };

/** A run stops starting new chain reads after this long (the cron fires every 10 minutes). */
const RUN_MS = 7 * 60_000;

export const budgetFor = (max = 300, gap = 500): Budget => ({ calls: 0, max, gap, until: Date.now() + RUN_MS });
export const left = (b: Budget) => (b.limited || Date.now() > b.until ? 0 : b.max - b.calls);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${n.toString(16)}`;
const ZERO = "0x0000000000000000000000000000000000000000";

export class RateLimited extends Error {
  constructor() {
    super("Alchemy's rate limit: carrying on at the next run");
  }
}

/**
 * One request. `weight` stretches the wait before the next one for a heavier batch: 1 is the
 * baseline of ~170 compute units (ten transaction lookups) per CALL_GAP_MS.
 */
async function post<T>(env: ChainEnv, b: Budget, body: unknown, weight = 1): Promise<T> {
  if (!env.rpcUrl) throw new Error("No Alchemy URL for this chain");
  if (b.limited) throw new RateLimited();
  if (b.calls >= b.max || Date.now() > b.until) throw new Error("out of calls for this run");
  b.calls++;
  for (let attempt = 0; ; attempt++) {
    const wait = (b.last ?? 0) + b.gap - Date.now();
    if (wait > 0) await sleep(wait);
    b.last = Date.now() + (Math.max(1, weight) - 1) * b.gap;
    const res = await (env.fetch ?? fetch)(env.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.status >= 500 && attempt < 2) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429) {
      b.limited = true;
      throw new RateLimited();
    }
    if (!res.ok) throw new Error(`Alchemy said ${res.status}`);
    return (await res.json()) as T;
  }
}

async function rpc<T>(env: ChainEnv, b: Budget, method: string, params: unknown[]): Promise<T> {
  const json = await post<{ result?: T; error?: { code?: number; message: string } }>(env, b, { jsonrpc: "2.0", id: 1, method, params });
  if (json.error) {
    if (json.error.code === 429 || /rate|capacity/i.test(json.error.message)) {
      b.limited = true;
      throw new RateLimited();
    }
    throw new Error(`Alchemy: ${json.error.message}`);
  }
  return json.result as T;
}

/** Alchemy's compute units per call, for spacing batches. */
const CU: Record<string, number> = { eth_getTransactionByHash: 17, eth_call: 26, eth_getCode: 26 };

/** Several calls in one request; a missing or failed answer comes back null. */
async function batch<T>(env: ChainEnv, b: Budget, calls: [string, unknown[]][]): Promise<(T | null)[]> {
  const weight = calls.reduce((a, [m]) => a + (CU[m] ?? 26), 0) / 170;
  const out = await post<{ id: number; result?: T; error?: { code?: number; message: string } }[]>(
    env,
    b,
    calls.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params })),
    weight,
  );
  if (!Array.isArray(out)) throw new Error("Alchemy: batch answer wasn't a list");
  if (out.some((r) => r.error && (r.error.code === 429 || /rate|capacity/i.test(r.error.message)))) b.limited = true;
  const byId = new Map(out.map((r) => [r.id, r.result ?? null]));
  return calls.map((_, i) => byId.get(i) ?? null);
}

export const headBlock = async (env: ChainEnv, b: Budget) => Number(await rpc<string>(env, b, "eth_blockNumber", []));

type AlchemyTransfer = {
  blockNum: string;
  uniqueId: string;
  hash: string;
  from: string;
  to: string | null;
  category: string;
  erc721TokenId?: string | null;
  tokenId?: string | null;
  erc1155Metadata?: { tokenId: string; value: string }[] | null;
  rawContract: { value?: string | null };
  metadata: { blockTimestamp: string };
};

export type RawTransfer = { id: string; contract: string; block: number; logIndex: number; at: number; tx: string; from: string; to: string; tokenId: string | null; amount: number };

function parse(contract: string, standard: Standard, decimals: number, t: AlchemyTransfer): RawTransfer[] {
  const base = {
    contract,
    block: Number(t.blockNum),
    logIndex: Number(t.uniqueId.split(":").pop()) || 0,
    at: Date.parse(t.metadata.blockTimestamp),
    tx: t.hash.toLowerCase(),
    from: (t.from ?? ZERO).toLowerCase(),
    to: (t.to ?? ZERO).toLowerCase(),
  };
  if (standard === "erc721") return [{ ...base, id: t.uniqueId, tokenId: BigInt(t.erc721TokenId ?? t.tokenId ?? 0).toString(), amount: 1 }];
  if (standard === "erc1155")
    return (t.erc1155Metadata ?? []).map((m) => ({ ...base, id: `${t.uniqueId}:${BigInt(m.tokenId)}`, tokenId: BigInt(m.tokenId).toString(), amount: Number(BigInt(m.value)) }));
  return [{ ...base, id: t.uniqueId, tokenId: null, amount: units(BigInt(t.rawContract.value ?? "0x0"), decimals) }];
}

/** A raw ERC-20 amount as whole tokens (a float: fine for counting holders, not for accounting). */
export function units(raw: bigint, decimals: number) {
  const scale = 10n ** BigInt(decimals);
  return Number(raw / scale) + Number(raw % scale) / Number(scale);
}

/**
 * The next stretch of a contract's transfers from `from` to `to`, whole blocks only: a page that
 * stops partway through a block leaves that block for the next read.
 */
export async function readTransfers(
  env: ChainEnv,
  b: Budget,
  c: { contract: string; standard: Standard; decimals: number },
  from: number,
  to: number,
): Promise<{ rows: RawTransfer[]; through: number }> {
  const ask = (pageKey?: string) =>
    rpc<{ transfers: AlchemyTransfer[]; pageKey?: string }>(env, b, "alchemy_getAssetTransfers", [
      {
        fromBlock: hex(from),
        toBlock: hex(to),
        contractAddresses: [c.contract],
        category: [c.standard],
        withMetadata: true,
        excludeZeroValue: false,
        maxCount: "0x3e8",
        order: "asc",
        ...(pageKey ? { pageKey } : {}),
      },
    ]);
  let page = await ask();
  const rows = page.transfers.flatMap((t) => parse(c.contract, c.standard, c.decimals, t));
  if (!page.pageKey) return { rows, through: to };
  // One block with more than a page of transfers (a big mint): read on until it's whole.
  while (page.pageKey && rows.length && rows[0].block === rows[rows.length - 1].block && left(b) > 1) {
    page = await ask(page.pageKey);
    rows.push(...page.transfers.flatMap((t) => parse(c.contract, c.standard, c.decimals, t)));
  }
  if (!page.pageKey) return { rows, through: to };
  const last = rows[rows.length - 1].block;
  const whole = rows.filter((r) => r.block < last);
  if (!whole.length) throw new Error(`Block ${last} has more transfers than one run can read`);
  return { rows: whole, through: last - 1 };
}

/** Sender, target and ETH value of each transaction (sales, mints for others, operators). */
export async function txDetails(env: ChainEnv, b: Budget, hashes: string[]) {
  const res = await batch<{ from: string; to: string | null; value: string }>(
    env,
    b,
    hashes.map((h) => ["eth_getTransactionByHash", [h]]),
  );
  return new Map(hashes.flatMap((h, i) => (res[i] ? [[h, { from: res[i]!.from.toLowerCase(), to: (res[i]!.to ?? "").toLowerCase(), value: BigInt(res[i]!.value).toString() }] as const] : [])));
}

/** Which of these addresses are contracts (one call for up to 100). */
export async function areContracts(env: ChainEnv, b: Budget, wallets: string[]) {
  const res = await batch<string>(env, b, wallets.map((w) => ["eth_getCode", [w, "latest"]]));
  return new Map(wallets.map((w, i) => [w, res[i] === null ? null : res[i] !== "0x"]));
}

const firstTransfer = (env: ChainEnv, b: Budget, params: Record<string, unknown>) =>
  rpc<{ transfers: AlchemyTransfer[] }>(env, b, "alchemy_getAssetTransfers", [
    { fromBlock: "0x0", toBlock: "latest", withMetadata: true, excludeZeroValue: true, maxCount: "0x1", ...params },
  ]).then((r) => r.transfers[0] ?? null);

/** Who first sent the wallet ETH (one call). */
export async function funderOf(env: ChainEnv, b: Budget, wallet: string) {
  const t = await firstTransfer(env, b, { toAddress: wallet, category: ["external", "internal"], order: "asc" });
  return t ? { funder: (t.from ?? "").toLowerCase(), fundedAt: Date.parse(t.metadata.blockTimestamp) } : { funder: null, fundedAt: null };
}

/** The last transaction or token transfer the wallet sent (one call). */
export async function lastOutOf(env: ChainEnv, b: Budget, wallet: string) {
  const t = await firstTransfer(env, b, { fromAddress: wallet, category: ["external", "erc20", "erc721", "erc1155"], order: "desc" });
  return t ? Date.parse(t.metadata.blockTimestamp) : null;
}

const DELEGATE_V2 = "0x00000000000000447e69651d841bD8D104Bed493";
const DELEGATE_V1 = "0x00000000000076A84feF008CDAbe6409d2FE638B";
const WARM = "0xC3AA9bc72Bd623168860a1e5c6a4530d3D80456c";
const v2 = parseAbi([
  "struct Delegation { uint8 type_; address to; address from; bytes32 rights; address contract_; uint256 tokenId; uint256 amount; }",
  "function getOutgoingDelegations(address from) view returns (Delegation[] delegations_)",
]);
const v1 = parseAbi([
  "struct DelegationInfo { uint8 type_; address vault; address delegate; address contract_; uint256 tokenId; }",
  "function getDelegationsByVault(address vault) view returns (DelegationInfo[] info)",
]);
const warm = parseAbi(["function getHotWallet(address coldWallet) view returns (address)"]);

/** delegate.xyz v2 and v1 and warm.xyz delegations each wallet made, now (one call for a few: 3 reads each). Null where a read failed. */
export async function delegationsOf(env: ChainEnv, b: Budget, wallets: string[]): Promise<Map<string, Delegation[] | null>> {
  const calls: [string, unknown[]][] = wallets.flatMap((w) => [
    ["eth_call", [{ to: DELEGATE_V2, data: encodeFunctionData({ abi: v2, functionName: "getOutgoingDelegations", args: [w as `0x${string}`] }) }, "latest"]],
    ["eth_call", [{ to: DELEGATE_V1, data: encodeFunctionData({ abi: v1, functionName: "getDelegationsByVault", args: [w as `0x${string}`] }) }, "latest"]],
    ["eth_call", [{ to: WARM, data: encodeFunctionData({ abi: warm, functionName: "getHotWallet", args: [w as `0x${string}`] }) }, "latest"]],
  ]);
  const res = await batch<`0x${string}`>(env, b, calls);
  const out = new Map<string, Delegation[] | null>();
  wallets.forEach((w, i) => {
    const [r2, r1, rw] = res.slice(i * 3, i * 3 + 3);
    // A registry that reverts answers null; only a wallet with no answers at all is tried again.
    if (!r2 && !r1 && !rw) return out.set(w, null);
    const list: Delegation[] = [];
    try {
      for (const d of decodeFunctionResult({ abi: v2, functionName: "getOutgoingDelegations", data: r2! }))
        list.push({ src: "v2", type: d.type_, to: d.to.toLowerCase(), contract: d.contract_ === ZERO ? null : d.contract_.toLowerCase() });
    } catch {}
    try {
      for (const d of decodeFunctionResult({ abi: v1, functionName: "getDelegationsByVault", data: r1! }))
        list.push({ src: "v1", type: d.type_, to: d.delegate.toLowerCase(), contract: d.contract_ === ZERO ? null : d.contract_.toLowerCase() });
    } catch {}
    try {
      const hot = decodeFunctionResult({ abi: warm, functionName: "getHotWallet", data: rw! });
      if (hot !== ZERO) list.push({ src: "warm", type: 1, to: hot.toLowerCase(), contract: null });
    } catch {}
    out.set(w, list);
  });
  return out;
}

const REVERSE_RECORDS = "0x3671aE578E63FdF66ad4F3E12CC0c0d71Ac7510C";
const reverseAbi = parseAbi(["function getNames(address[] addresses) view returns (string[] r)"]);

/** ENS primary names (one call per lookup; a broken resolver fails the call, so halve until found). */
export async function ensNames(env: ChainEnv, b: Budget, wallets: string[], out = new Map<string, string>()): Promise<Map<string, string>> {
  if (!wallets.length || left(b) < 1) return out;
  try {
    const data = await rpc<`0x${string}`>(env, b, "eth_call", [
      { to: REVERSE_RECORDS, data: encodeFunctionData({ abi: reverseAbi, functionName: "getNames", args: [wallets as `0x${string}`[]] }) },
      "latest",
    ]);
    const names = decodeFunctionResult({ abi: reverseAbi, functionName: "getNames", data });
    wallets.forEach((w, i) => names[i] && out.set(w, names[i]));
  } catch (err) {
    if (err instanceof RateLimited || wallets.length === 1) return out;
    await ensNames(env, b, wallets.slice(0, wallets.length >> 1), out);
    await ensNames(env, b, wallets.slice(wallets.length >> 1), out);
  }
  return out;
}

/** An OpenSea username, or null; undefined when OpenSea didn't answer (try again later). */
export async function openseaName(env: ChainEnv, wallet: string): Promise<string | null | undefined> {
  const res = await (env.fetch ?? fetch)(`https://api.opensea.io/api/v2/accounts/${wallet}`, { headers: { accept: "application/json", "x-api-key": env.openseaKey! } }).catch(() => null);
  if (res?.status === 404 || res?.status === 400) return null;
  if (!res?.ok) return undefined;
  const j = (await res.json().catch(() => ({}))) as { username?: string | null };
  return j.username || null;
}

/**
 * Every transaction the wallet signed (Etherscan txlist), split at `since` (ms, when it first got
 * the project's core tokens): before, and after outside the project's contracts and transfers.
 * Null when Etherscan didn't answer.
 */
export async function usageOf(env: ChainEnv, wallet: string, since: number, projectContracts: Set<string>, projectTxs: (hashes: string[]) => Promise<Set<string>>): Promise<Usage | null> {
  const url = `https://api.etherscan.io/v2/api?chainid=${env.chainId}&module=account&action=txlist&address=${wallet}&startblock=0&endblock=99999999&sort=asc&page=1&offset=10000&apikey=${env.etherscanKey}`;
  const d = (await (env.fetch ?? fetch)(url)
    .then((r) => r.json())
    .catch(() => null)) as { status?: string; message?: string; result?: { hash: string; from: string; to: string; input: string; timeStamp: string }[] } | null;
  if (!d) return null;
  const list = d.status === "1" ? d.result! : d.status === "0" && /No transactions/i.test(d.message ?? "") ? [] : null;
  if (!list) return null;
  const at = since / 1000;
  const mine = list.filter((t) => t.from.toLowerCase() === wallet);
  const ours = await projectTxs(mine.map((t) => t.hash.toLowerCase()));
  const u: Usage = { before: 0, after: 0, after_other: 0, first_sent: null, last_before: null, last_other: null, other_contracts: 0 };
  const others = new Set<string>();
  for (const t of mine) {
    const ts = Number(t.timeStamp);
    const to = (t.to || "").toLowerCase();
    const project = projectContracts.has(to) || ours.has(t.hash.toLowerCase());
    const call = to && t.input && t.input !== "0x";
    u.first_sent ??= ts;
    if (!project && call) others.add(to);
    if (ts < at) {
      u.before++;
      u.last_before = ts;
    } else if (ts > at || !project) {
      u.after++;
      if (!project) {
        u.after_other++;
        u.last_other = ts;
      }
    }
  }
  u.other_contracts = others.size;
  return u;
}
