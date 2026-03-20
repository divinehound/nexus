// Server-side: use the internal Docker network URL to reach the API directly.
// Client-side: use a relative path that Next.js rewrites to the API server.
const API_BASE =
  typeof window === 'undefined'
    ? (process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api')
    : (process.env.NEXT_PUBLIC_API_URL || '/api');

export class ApiError extends Error {
  status: number;
  statusText: string;
  data: any;

  constructor(status: number, statusText: string, data: any) {
    super(data?.message || `API error: ${status} ${statusText}`);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.data = data;
  }
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit & { token?: string },
): Promise<T> {
  const { token, ...init } = options || {};
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string>),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, res.statusText, body);
  }
  return res.json();
}

export type CollectionVerificationStatus =
  | 'tracked_unverified'
  | 'pending_claim'
  | 'verified'
  | 'rejected';

export type CollectionMappingStatus =
  | 'unmapped'
  | 'suggested'
  | 'mapped'
  | 'rejected';

export interface CollectionProjectRef {
  id: string;
  name: string;
  slug: string;
  isVerified: boolean;
}

export interface CollectionMetrics {
  floorPrice: number | null;
  holderCount: number | null;
  listedCount: number | null;
  volume24h: number | null;
}

export interface CollectionDetails {
  id: string;
  chain: string;
  contractAddress: string;
  name: string;
  imageUrl: string | null;
  collectionType: string;
  verificationStatus: CollectionVerificationStatus;
  mappingStatus: CollectionMappingStatus;
  verificationNotes: string | null;
  mappingConfidence: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  project: CollectionProjectRef | null;
  proposedProject: CollectionProjectRef | null;
  metrics: CollectionMetrics;
}

export interface CollectionStatsCurrent {
  floorPrice: number | null;
  listedCount: number | null;
  holderCount: number | null;
  volume1h: number | null;
  volume24h: number | null;
  volume7d: number | null;
  sales24h: number | null;
  uniqueBuyers24h: number | null;
}

export interface CollectionStatsResponse {
  collectionId: string;
  status: 'ready' | 'indexing' | 'stale';
  lastUpdatedAt: string | null;
  current: CollectionStatsCurrent | null;
  deltas: {
    floor24hPct?: number;
    volume24hPct?: number;
    holders24hDelta?: number;
  };
  history7d: Array<{
    timestamp: string;
    floorPrice: number | null;
    volume24h: number | null;
    holderCount: number | null;
  }>;
}

export interface TrackCollectionResponse {
  statusCode: number;
  collectionId: string;
  status: CollectionVerificationStatus;
  routeHint: string;
}

export interface TrackCollectionInput {
  chain: string;
  contractAddress: string;
}

export function trackCollection(input: TrackCollectionInput) {
  return apiFetch<TrackCollectionResponse>('/collections/track', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getCollectionByChainAndContract(chain: string, contractAddress: string) {
  return apiFetch<CollectionDetails>(`/collections/${encodeURIComponent(chain)}/${encodeURIComponent(contractAddress)}`);
}

export function getCollectionStats(chain: string, contractAddress: string) {
  return apiFetch<CollectionStatsResponse>(`/collections/${encodeURIComponent(chain)}/${encodeURIComponent(contractAddress)}/stats`);
}

export interface AdminCollectionActionInput {
  notes?: string;
  projectId?: string;
}

export function adminVerifyCollection(
  collectionId: string,
  input: AdminCollectionActionInput,
  token: string,
) {
  return apiFetch<CollectionDetails>(`/admin/collections/${collectionId}/verify`, {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export function adminRejectCollection(collectionId: string, input: { notes?: string }, token: string) {
  return apiFetch<CollectionDetails>(`/admin/collections/${collectionId}/reject`, {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export interface AdminSuggestProjectInput {
  projectId: string;
  confidence: number;
  notes?: string;
}

export function adminSuggestProject(
  collectionId: string,
  input: AdminSuggestProjectInput,
  token: string,
) {
  return apiFetch<CollectionDetails>(`/admin/collections/${collectionId}/suggest-project`, {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export interface MeProfile {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  primaryWalletId: string | null;
}

export interface LinkedWallet {
  id: string;
  chain: string;
  address: string;
  ensName: string | null;
  snsName: string | null;
  isPrimary: boolean;
}

export interface MeResponse extends MeProfile {
  role: string;
  echoScore: number | null;
  wallets: LinkedWallet[];
}

export interface WalletChallengeResponse {
  nonce: string;
  message: string;
}

export interface WalletVerifyResponse {
  success: boolean;
  wallet: LinkedWallet;
  moved: boolean;
  idempotent?: boolean;
}

export interface WalletMoveResponse {
  success: boolean;
  wallet: LinkedWallet;
  moved: boolean;
}

export function getMe(token: string) {
  return apiFetch<MeResponse>('/me', { token });
}

export function patchMyProfile(
  input: { displayName?: string; avatarUrl?: string; bio?: string },
  token: string,
) {
  return apiFetch<MeResponse>('/me/profile', {
    method: 'PATCH',
    token,
    body: JSON.stringify(input),
  });
}

export function getMyWallets(token: string) {
  return apiFetch<LinkedWallet[]>('/me/wallets', { token });
}

export function createWalletChallenge(
  input: { chain: string; address: string; purpose: 'link_wallet' },
  token: string,
) {
  return apiFetch<WalletChallengeResponse>('/me/wallets/challenge', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export function verifyWalletLink(
  input: { chain: string; address: string; signature: string; message: string },
  token: string,
) {
  return apiFetch<WalletVerifyResponse>('/me/wallets/verify', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export function moveWalletLink(
  input: { chain: string; address: string; confirmationToken: string; signature: string; message: string },
  token: string,
) {
  return apiFetch<WalletMoveResponse>('/me/wallets/move', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export function setPrimaryWallet(walletId: string, token: string) {
  return apiFetch<{ success: boolean; primaryWalletId: string }>(`/me/wallets/${walletId}/primary`, {
    method: 'PATCH',
    token,
  });
}

export function removeWallet(walletId: string, token: string) {
  return apiFetch<{ success: boolean }>(`/me/wallets/${walletId}`, {
    method: 'DELETE',
    token,
  });
}
