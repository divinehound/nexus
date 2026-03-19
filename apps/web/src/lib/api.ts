// Server-side: use the internal Docker network URL to reach the API directly.
// Client-side: use a relative path that Next.js rewrites to the API server.
const API_BASE =
  typeof window === 'undefined'
    ? (process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api')
    : (process.env.NEXT_PUBLIC_API_URL || '/api');

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
    throw new Error(body.message || `API error: ${res.status} ${res.statusText}`);
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
