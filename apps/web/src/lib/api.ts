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

export interface RelatedCollection {
  id: string;
  name: string;
  contractAddress: string;
  chain: string;
  imageUrl: string | null;
  sharedHolders: number;
  totalHolders: number;
  overlapPercentage: number;
}

export function getRelatedCollections(collectionId: string, limit: number = 10) {
  return apiFetch<RelatedCollection[]>(`/collections/${collectionId}/related?limit=${limit}`);
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

export function adminEnrichCollection(collectionId: string, token: string) {
  return apiFetch<{ success: boolean; collection?: any; metadata?: any; message?: string }>(
    `/admin/collections/${collectionId}/enrich`,
    { method: 'POST', token },
  );
}

export function adminIndexCollectionHolders(collectionId: string, token: string) {
  return apiFetch<{ success: boolean; collection: string; holdersIndexed: number; error?: string }>(
    `/admin/collections/${collectionId}/index-holders`,
    { method: 'POST', token },
  );
}

export function adminMarkCollectionAsSpam(collectionId: string, notes: string | undefined, token: string) {
  return apiFetch<{ success: boolean; collection: string }>(
    `/admin/collections/${collectionId}/mark-spam`,
    { method: 'POST', token, body: JSON.stringify({ notes }) },
  );
}

export function adminMarkCollectionAsNotSpam(collectionId: string, reason: string | undefined, token: string) {
  return apiFetch<{ success: boolean; collection: string }>(
    `/admin/collections/${collectionId}/mark-not-spam`,
    { method: 'POST', token, body: JSON.stringify({ reason }) },
  );
}

export function adminBulkCheckSpam(token: string) {
  return apiFetch<{ status: string; message: string }>(
    `/admin/collections/bulk-check-spam`,
    { method: 'POST', token },
  );
}

export function adminCheckSpamRaw(collectionId: string, token: string) {
  return apiFetch<any>(
    `/admin/collections/${collectionId}/check-spam-raw`,
    { method: 'GET', token },
  );
}

export type IndexingJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface AdminIndexingJobListItem {
  id: string;
  type: string;
  status: IndexingJobStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  userId: string | null;
  walletId: string | null;
  entityType?: string;
  entityId?: string;
  statsJson: Record<string, unknown> | null;
  error: string | null;
}

export interface AdminIndexingJobListResponse {
  items: AdminIndexingJobListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface AdminIndexingJobDetails extends AdminIndexingJobListItem {
  retryOfJobId: string | null;
  wallet: {
    id: string;
    address: string;
    chain: string;
    userId: string | null;
    isPrimary: boolean;
    ensName: string | null;
    snsName: string | null;
    lastSyncedAt: string | null;
  } | null;
}

export function getAdminIndexingJobs(
  token: string,
  input: { status?: IndexingJobStatus; walletId?: string; page?: number; limit?: number } = {},
) {
  const params = new URLSearchParams();
  if (input.status) params.set('status', input.status);
  if (input.walletId) params.set('walletId', input.walletId);
  if (input.page) params.set('page', String(input.page));
  if (input.limit) params.set('limit', String(input.limit));
  return apiFetch<AdminIndexingJobListResponse>(`/admin/indexing/jobs?${params.toString()}`, { token });
}

export function getAdminIndexingJob(id: string, token: string) {
  return apiFetch<AdminIndexingJobDetails>(`/admin/indexing/jobs/${id}`, { token });
}

export function retryAdminIndexingJob(id: string, token: string) {
  return apiFetch<{ queued: boolean; originalJobId: string; retryJobId: string }>(
    `/admin/indexing/jobs/${id}/retry`,
    {
      method: 'POST',
      token,
    },
  );
}

export type IndexStatusState = 'queued' | 'running' | 'done' | 'failed' | null;

export interface AdminIndexStatusResponse {
  entityType: 'wallet' | 'collection' | 'project';
  entityId: string;
  lastIndexStartedAt: string | null;
  lastIndexFinishedAt: string | null;
  lastIndexStatus: IndexStatusState;
  lastIndexError: string | null;
  lastIndexJobId: string | null;
}

export interface AdminRefreshResponse {
  queued: boolean;
  jobId: string;
  entityType: 'wallet' | 'collection' | 'project';
  entityId: string;
}

export function getAdminWalletIndexStatus(walletId: string, token: string) {
  return apiFetch<AdminIndexStatusResponse>(`/admin/indexing/status/wallet/${encodeURIComponent(walletId)}`, { token });
}

export function getAdminCollectionIndexStatus(idOrContract: string, token: string) {
  return apiFetch<AdminIndexStatusResponse>(`/admin/indexing/status/collection/${encodeURIComponent(idOrContract)}`, { token });
}

export function getAdminProjectIndexStatus(idOrSlug: string, token: string) {
  return apiFetch<AdminIndexStatusResponse>(`/admin/indexing/status/project/${encodeURIComponent(idOrSlug)}`, { token });
}

export function refreshAdminWalletIndexing(walletId: string, token: string) {
  return apiFetch<AdminRefreshResponse>(`/admin/indexing/wallet/${encodeURIComponent(walletId)}/refresh`, {
    method: 'POST',
    token,
  });
}

export function refreshAdminCollectionIndexing(collectionId: string, token: string) {
  return apiFetch<AdminRefreshResponse>(`/admin/indexing/collection/${encodeURIComponent(collectionId)}/refresh`, {
    method: 'POST',
    token,
  });
}

export function refreshAdminProjectIndexing(projectId: string, token: string) {
  return apiFetch<AdminRefreshResponse>(`/admin/indexing/project/${encodeURIComponent(projectId)}/refresh`, {
    method: 'POST',
    token,
  });
}

export interface MeProfile {
  id: string;
  email: string | null;
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

export interface HoldingsSummaryResponse {
  tiers: {
    active: number;
    lightweight: number;
    suppressed: number;
  };
  walletCoverage: number;
  lastIndexedAt: string | null;
  lastJobStatus: string | null;
}

export interface HoldingsCollectionItem {
  id: string;
  name: string;
  chain: string;
  contractAddress: string;
  imageUrl: string | null;
  tier: 'active' | 'lightweight' | 'suppressed';
  qualityScore: string | null;
  qualityReason: string | null;
  projectName: string | null;
  projectSlug: string | null;
  tokenCount: number;
}

export interface HoldingsCollectionsResponse {
  items: HoldingsCollectionItem[];
  total: number;
  page: number;
  limit: number;
  tier: 'active' | 'lightweight' | 'suppressed';
}

export function getMe(token: string) {
  return apiFetch<MeResponse>('/me', { token });
}

export function patchMyProfile(
  input: { email?: string; displayName?: string; avatarUrl?: string; bio?: string },
  token: string,
) {
  return apiFetch<MeResponse>('/me/profile', {
    method: 'PATCH',
    token,
    body: JSON.stringify(input),
  });
}

export function getMyHoldingsSummary(token: string) {
  return apiFetch<HoldingsSummaryResponse>('/me/holdings/summary', { token });
}

export function getMyHoldingsCollections(
  token: string,
  tier: 'active' | 'lightweight' | 'suppressed',
  page = 1,
  limit = 10,
) {
  return apiFetch<HoldingsCollectionsResponse>(
    `/me/holdings/collections?tier=${encodeURIComponent(tier)}&page=${page}&limit=${limit}`,
    { token },
  );
}

export function getMyWallets(token: string) {
  return apiFetch<LinkedWallet[]>('/me/wallets', { token });
}

export function createWalletChallenge(
  input: { chain: string; address: string; purpose: 'link_wallet' | 'move_wallet'; confirmationToken?: string },
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

// --- Collections: Discovery & Recommendations ---

export interface NetworkGraphNode {
  id: string;
  name: string;
  chain: string;
  contractAddress: string;
  imageUrl: string | null;
  holderCount: number;
}

export interface NetworkGraphEdge {
  source: string;
  target: string;
  sharedHolders: number;
  weight: number;
  holderDataReliable?: boolean;
}

export interface NetworkGraph {
  nodes: NetworkGraphNode[];
  edges: NetworkGraphEdge[];
}

export function getNetworkGraph(options?: {
  strategy?: 'top-collections' | 'connected-traverse';
  minSharedHolders?: number;
  maxNodes?: number;
  chains?: string[];
  focusCollectionId?: string;
}): Promise<NetworkGraph> {
  const params = new URLSearchParams();
  if (options?.strategy) params.set('strategy', options.strategy);
  if (options?.minSharedHolders) params.set('minSharedHolders', options.minSharedHolders.toString());
  if (options?.maxNodes) params.set('maxNodes', options.maxNodes.toString());
  if (options?.chains?.length) params.set('chains', options.chains.join(','));
  if (options?.focusCollectionId) params.set('focusCollectionId', options.focusCollectionId);
  
  return apiFetch<NetworkGraph>(`/collections/network/graph?${params.toString()}`);
}

export interface Recommendation {
  collection: {
    id: string;
    name: string;
    chain: string;
    contractAddress: string;
    imageUrl: string | null;
    holderCount: number;
    floorPrice: number | null;
  };
  score: number;
  sharedHolders: number;
  basedOn: Array<{
    id: string;
    name: string;
    overlap: number;
  }>;
  reason: string;
}

export function getRecommendations(
  chain: string,
  address: string,
  options?: { limit?: number; minOverlap?: number },
): Promise<Recommendation[]> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', options.limit.toString());
  if (options?.minOverlap) params.set('minOverlap', options.minOverlap.toString());
  
  return apiFetch<Recommendation[]>(
    `/collections/recommendations/${chain}/${address}?${params.toString()}`,
  );
}
