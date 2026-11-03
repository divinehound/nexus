// The holder analysis API (apps/api src/modules/holder-analysis): admin settings under
// /admin/holder-analysis, a project's report under /projects/:projectId/holder-analysis
// (owners, editors and admins only).

import { API_BASE, apiFetch } from '@/lib/api';

export type Who = { ens: string | null; opensea: string | null; label: string | null; note: string | null; nickname: string | null };
export type Paged<T> = { total: number; page: number; perPage: number; rows: T[] };
export type Data = Record<string, string | number | boolean | null>;

export type AnalysisCollection = { id: string; collectionId: string; name: string; chain: string; standard: string; core: boolean };

export type Overview = {
  projectId: string;
  name: string;
  collections: AnalysisCollection[];
  waiting: string[];
  report: { analysedAt: string; version: number; durationMs: number; summary: Summary } | null;
  who: Record<string, Who>;
};

export type CollectionSummary = {
  name: string;
  short: string;
  standard: string;
  transfers: number;
  minted: number;
  holders_now: number;
  staked_now: number;
  series: { month: string; holders: number; staked: number; tokens: number; top10: number }[];
  status: { wallets: Record<string, number>; tokens: Record<string, number> };
  volume: { month: string; sales: number; eth: number }[];
};

export type Summary = {
  as_of: string;
  generated: string;
  collections: Record<string, CollectionSummary>;
  side: Record<string, { name: string; holders_now: number; supply: number; also_hold_core: number }>;
  holders_total: number;
  holders_multi: number;
  status_all: Record<string, number>;
  clusters: { count: number; wallets: number };
  named: { ens: number; opensea: number; either: number };
  activity: { d7: Record<string, number>; d30: Record<string, number> };
  top_holders: Data[];
  [key: string]: unknown;
};

export type HolderRow = Who & { rank: number; address: string; firstAt: string | null; data: Data };
export type ActivityRow = Omit<Who, 'note'> & {
  at: string;
  collectionId: string;
  address: string;
  kind: string;
  amount: number;
  tx: string;
  eth: number;
  flag: string;
};

export type WalletDetail = {
  address: string;
  who: Who | null;
  holder: { rank: number; firstAt: string | null; data: Data } | null;
  side: { collectionId: string; rank: number; data: Data }[];
  profiles: { chain: string; isContract: boolean | null; funder: string | null; fundedAt: string | null; lastOutAt: string | null; checkedAt: string | null; delegations: { src: string; type: number; to: string; contract: string | null }[] | null }[];
  transfers: Paged<{ collectionId: string; block: number; at: string; tx: string; from: string; to: string; logIndex: number; tokenId: string | null; amount: number; txFrom: string | null; txValueWei: string | null; kind: string }>;
  groups: { rank: number; data: Data }[];
  links: { other: string; score: number; evidence: string }[];
  funded: { address: string; fundedAt: string | null; holderRank: number | null }[];
  unlinked: { other: string; at: string }[];
  activity: { at: string; collectionId: string; kind: string; amount: number; tx: string; eth: number; flag: string }[];
  others: Record<string, Who>;
};

export type AdminStatus = {
  projectId: string;
  name: string;
  enabled: boolean;
  collections: {
    collectionId: string;
    name: string;
    chain: string;
    contractAddress: string;
    settings: { shortId: string; standard: string; core: boolean; decimals: number; stakingContracts: string[]; tokenNames: Record<string, string>; saved: boolean } | null;
    sync: { lastBlock: number | null; live: boolean; syncedAt: string | null; error: string | null; errorAt: string | null; transfers: number; transactionsPending: number };
  }[];
  wallets: { total: number; read: number; delegations: number; named: number };
};

export type ImportResult = {
  settings: { from: string | null; saved: string[]; kept: string[]; failed: { collection: string; error: string }[]; missing: string[] } | null;
  labels: { sent: number; added: number; kept: number; skipped: number };
  unlinks: { sent: number; added: number; kept: number; skipped: number };
  queued: boolean;
};

/**
 * Sorts rows exported from the old app's D1 (`wrangler d1 execute ... --json`, or plain lists of
 * rows) into its projects, wallet notes and unlinks, by their columns.
 */
export function sortOldAppRows(json: unknown) {
  const out = { projects: [] as Record<string, unknown>[], notes: [] as Record<string, unknown>[], unlinks: [] as Record<string, unknown>[] };
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.results)) return visit(o.results);
    if ('collections' in o && 'id' in o) out.projects.push(o);
    else if ('wallet' in o && ('label' in o || 'note' in o)) out.notes.push(o);
    else if ('a' in o && 'b' in o) out.unlinks.push(o);
  };
  visit(json);
  return out;
}

const base = (projectId: string) => `/projects/${projectId}/holder-analysis`;
const qs = (q: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const holderAnalysis = {
  overview: (projectId: string, token: string) => apiFetch<Overview>(base(projectId), { token }),
  holders: (projectId: string, q: { q?: string; show?: string; sort?: string; page?: number }, token: string) =>
    apiFetch<Paged<HolderRow>>(`${base(projectId)}/holders${qs(q)}`, { token }),
  side: (projectId: string, collectionId: string, page: number, token: string) =>
    apiFetch<Paged<HolderRow>>(`${base(projectId)}/side/${collectionId}${qs({ page })}`, { token }),
  wallet: (projectId: string, address: string, page: number, token: string) =>
    apiFetch<WalletDetail>(`${base(projectId)}/wallets/${address}${qs({ page })}`, { token }),
  groups: (projectId: string, page: number, token: string) =>
    apiFetch<Paged<{ rank: number; data: Data }> & { who: Record<string, Who> }>(`${base(projectId)}/groups${qs({ page })}`, { token }),
  activity: (projectId: string, q: { kind?: string; collectionId?: string; labelled?: string; page?: number }, token: string) =>
    apiFetch<Paged<ActivityRow>>(`${base(projectId)}/activity${qs(q)}`, { token }),
  saveLabel: (projectId: string, address: string, body: { label: string; note: string }, token: string) =>
    apiFetch<{ address: string; label: string; note: string }>(`${base(projectId)}/wallets/${address}/label`, { method: 'PUT', body: JSON.stringify(body), token }),
  unlink: (projectId: string, body: { wallet: string; others: string[]; remove?: boolean }, token: string) =>
    apiFetch<{ pairs: number; queued: boolean }>(`${base(projectId)}/unlinks`, { method: 'POST', body: JSON.stringify(body), token }),
  analyse: (projectId: string, token: string) => apiFetch<{ queued: boolean }>(`${base(projectId)}/analyse`, { method: 'POST', token }),

  adminStatus: (projectId: string, token: string) => apiFetch<AdminStatus>(`/admin/holder-analysis/projects/${projectId}`, { token }),
  adminSetEnabled: (projectId: string, enabled: boolean, token: string) =>
    apiFetch<AdminStatus>(`/admin/holder-analysis/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ enabled }), token }),
  adminSaveSettings: (collectionId: string, body: Record<string, unknown>, token: string) =>
    apiFetch<AdminStatus>(`/admin/holder-analysis/collections/${collectionId}/settings`, { method: 'PUT', body: JSON.stringify(body), token }),
  adminSync: (token: string) => apiFetch<{ queued: boolean }>(`/admin/holder-analysis/sync`, { method: 'POST', token }),
  adminImport: (projectId: string, body: { projects?: unknown[]; notes?: unknown[]; unlinks?: unknown[] }, token: string) =>
    apiFetch<ImportResult>(`/admin/holder-analysis/projects/${projectId}/import`, { method: 'POST', body: JSON.stringify(body), token }),
};

/** Downloads one of the report's CSVs (they need the sign-in token, so a plain link won't do). */
export async function downloadCsv(projectId: string, path: string, filename: string, token: string) {
  const res = await fetch(`${API_BASE}${base(projectId)}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const EXPLORERS: Record<string, string> = {
  ethereum: 'https://etherscan.io',
  base: 'https://basescan.org',
  abstract: 'https://abscan.org',
  apechain: 'https://apescan.io',
  polygon: 'https://polygonscan.com',
  robinhood: 'https://robinhoodchain.blockscout.com',
};
export const explorerAddress = (chain: string, address: string) => `${EXPLORERS[chain] ?? EXPLORERS.ethereum}/address/${address}`;
export const explorerTx = (chain: string, tx: string) => `${EXPLORERS[chain] ?? EXPLORERS.ethereum}/tx/${tx}`;
export const openseaProfile = (address: string) => `https://opensea.io/${address}`;

export const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  quiet: 'Quiet',
  parked: 'Parked',
  dormant_1y: 'Dormant 1y',
  dormant_2y: 'Dormant 2y',
  dormant_3y: 'Dormant 3y',
  dormant_4y: 'Dormant 4y+',
  unknown: 'Unknown',
};
export const STATUS_ORDER = Object.keys(STATUS_LABEL);

export const KIND_LABEL: Record<string, string> = {
  minted: 'Minted',
  bought: 'Bought',
  sold: 'Sold',
  received: 'Received',
  sent: 'Sent',
  burned: 'Burned',
  staked: 'Staked',
  unstaked: 'Unstaked',
  self: 'To itself',
};

export const shortAddr = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
/** Postgres timestamps come as "2026-01-04 00:00:00+00", which not every browser parses. */
export const toDate = (v: string) => new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
export const day = (v: string | null | undefined) => {
  if (!v) return '';
  const d = toDate(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
export const minute = (v: string) => {
  const d = toDate(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 16).replace('T', ' ');
};
export const num = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(v ?? ''));
