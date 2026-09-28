import type { CashflowWalletCoverage } from '@nexus/types';
import type { LedgerAsset, LedgerFee, LedgerMovement } from './cashflow-ledger';
import type { ChainFetchResult } from './evm-activity.fetcher';

/**
 * JSON form of one wallet's scan on one chain, as kept in `cashflow_scans`.
 * Chain and wallet are the row's own, so they aren't repeated per movement;
 * assets are stored once and referenced by key.
 */
export interface SavedChainScan {
  v: 1;
  assets: LedgerAsset[];
  movements: SavedMovement[];
  fees: SavedFee[];
  transfers: number;
  truncated: boolean;
  notes: string[];
  stats?: Record<string, number>;
  /** The scan failed with this message (nothing else is set). */
  error: string | null;
  /** The network isn't enabled on the Alchemy app — a config gap, not a failure. */
  disabled?: boolean;
  /** Where the last read stopped (see ChainFetchResult.cursor). */
  cursor?: { block?: string; time?: number };
}

export interface SavedMovement {
  h: string;
  t: number;
  d: 'in' | 'out';
  a: string;
  i: string | null;
  n: number;
  p: string;
  inf?: 1;
  ev?: 1;
}

interface SavedFee {
  h: string;
  t: number;
  f: number;
  s: string;
}

/** The linked wallet as the fetchers write it on movements (EVM lowercased). */
export function walletKey(chain: string, address: string): string {
  return chain === 'solana' ? address : address.toLowerCase();
}

export function toSaved(result: ChainFetchResult): SavedChainScan {
  const assets = new Map<string, LedgerAsset>();
  for (const m of result.movements) assets.set(m.asset.key, m.asset);
  return {
    v: 1,
    assets: [...assets.values()].map((a) => ({ ...a })),
    movements: result.movements.map((m) => ({
      h: m.txHash,
      t: m.timestamp.getTime(),
      d: m.direction,
      a: m.asset.key,
      i: m.tokenId,
      n: m.amount,
      p: m.counterparty,
      ...(m.inferred ? { inf: 1 as const } : {}),
      ...(m.fromEvent ? { ev: 1 as const } : {}),
    })),
    fees: result.fees.map((f) => ({
      h: f.txHash,
      t: f.timestamp.getTime(),
      f: f.feeNative,
      s: f.symbol,
    })),
    transfers: result.transfers,
    truncated: result.truncated,
    notes: result.notes,
    stats: result.stats,
    error: null,
    ...(result.cursor ? { cursor: result.cursor } : {}),
  };
}

export function failedScan(error: string, disabled = false): SavedChainScan {
  return {
    v: 1,
    assets: [],
    movements: [],
    fees: [],
    transfers: 0,
    truncated: false,
    notes: [],
    error,
    disabled,
  };
}

/**
 * Rebuild ledger inputs from a saved scan. `assets` is shared across every
 * row loaded together, so movements of one asset keep pointing at one object.
 */
export function fromSaved(
  saved: SavedChainScan,
  chain: string,
  address: string,
  scannedAt: Date,
  assets: Map<string, LedgerAsset>,
): {
  movements: LedgerMovement[];
  fees: LedgerFee[];
  coverage: CashflowWalletCoverage;
  notes: string[];
} {
  for (const a of saved.assets) {
    const existing = assets.get(a.key);
    // A later scan may have found a better name (e.g. collection metadata that failed before).
    if (existing) Object.assign(existing, a);
    else assets.set(a.key, { ...a });
  }
  const wallet = walletKey(chain, address);
  const movements: LedgerMovement[] = [];
  for (const m of saved.movements) {
    const asset = assets.get(m.a);
    if (!asset) continue;
    movements.push({
      chain,
      txHash: m.h,
      timestamp: new Date(m.t),
      wallet,
      direction: m.d,
      asset,
      tokenId: m.i,
      amount: m.n,
      counterparty: m.p,
      ...(m.inf ? { inferred: true } : {}),
      ...(m.ev ? { fromEvent: true } : {}),
    });
  }
  const fees: LedgerFee[] = saved.fees.map((f) => ({
    chain,
    txHash: f.h,
    wallet,
    timestamp: new Date(f.t),
    feeNative: f.f,
    symbol: f.s,
  }));
  return {
    movements,
    fees,
    coverage: {
      chain,
      address,
      transfers: saved.transfers,
      truncated: saved.truncated,
      error: saved.disabled ? null : saved.error,
      stats: saved.stats,
      scannedAt: scannedAt.toISOString(),
      disabled: saved.disabled ?? false,
    },
    notes: saved.notes,
  };
}

/**
 * Swap the given transactions in a saved scan for a fresh read of them — the
 * re-import of flagged transactions. Txs the fresh read didn't find (it moved
 * nothing for this wallet) are removed.
 */
export function replaceTxs(
  saved: SavedChainScan,
  hashes: Set<string>,
  fresh: ChainFetchResult,
): SavedChainScan {
  const next = toSaved(fresh);
  const assets = new Map(saved.assets.map((a) => [a.key, a]));
  for (const a of next.assets) assets.set(a.key, a);
  return {
    ...saved,
    assets: [...assets.values()],
    movements: [...saved.movements.filter((m) => !hashes.has(m.h)), ...next.movements].sort(
      (a, b) => b.t - a.t,
    ),
    fees: [...saved.fees.filter((f) => !hashes.has(f.h)), ...next.fees],
  };
}

/**
 * Where "fetch new" should resume: the saved cursor, or for Solana scans saved
 * before cursors existed, the newest saved tx. null → a full scan is needed.
 */
export function resumePoint(saved: SavedChainScan, chain: string): { block?: string; time?: number } | null {
  if (saved.error) return null;
  if (chain === 'solana') {
    if (saved.cursor?.time) return { time: saved.cursor.time };
    const newest = Math.max(0, ...saved.movements.map((m) => m.t), ...saved.fees.map((f) => f.t));
    return newest > 0 ? { time: Math.floor(newest / 1000) } : null;
  }
  return saved.cursor?.block ? { block: saved.cursor.block } : null;
}

/**
 * Fold a "fetch new" read into the saved scan. Txs in both (the read overlaps
 * the last one slightly) take the fresh version.
 */
export function mergeNew(saved: SavedChainScan, fresh: ChainFetchResult): SavedChainScan {
  const hashes = new Set([...fresh.movements.map((m) => m.txHash), ...fresh.fees.map((f) => f.txHash)]);
  const merged = replaceTxs(saved, hashes, fresh);
  const stats = { ...(saved.stats ?? {}) };
  for (const [k, v] of Object.entries(fresh.stats ?? {})) stats[k] = (stats[k] ?? 0) + v;
  return {
    ...merged,
    transfers: saved.transfers + fresh.transfers,
    truncated: saved.truncated || fresh.truncated,
    notes: [...new Set([...saved.notes, ...fresh.notes])],
    stats,
    cursor: fresh.cursor ?? saved.cursor,
  };
}

/**
 * NFTs (token ids) the wallet holds per a saved scan: received more times than
 * sent away, not counting moves to itself (e.g. into a listing escrow).
 */
export function nftsHeld(saved: SavedChainScan, wallet: string): Set<string> {
  const nft = new Set(saved.assets.filter((a) => a.kind === 'nft').map((a) => a.key));
  const count = new Map<string, number>();
  for (const m of saved.movements) {
    if (!m.i || !nft.has(m.a) || m.p === wallet) continue;
    count.set(m.i, (count.get(m.i) ?? 0) + (m.d === 'in' ? 1 : -1));
  }
  return new Set([...count].filter(([, n]) => n > 0).map(([id]) => id));
}
