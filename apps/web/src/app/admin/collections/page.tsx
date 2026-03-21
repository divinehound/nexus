'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  adminRejectCollection,
  adminSuggestProject,
  adminVerifyCollection,
  adminEnrichCollection,
  apiFetch,
  type CollectionMappingStatus,
  type CollectionVerificationStatus,
} from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { truncateAddress } from '@/lib/utils';

interface AdminProject {
  id: string;
  name: string;
  slug: string;
  collections: AdminCollection[];
}

interface AdminCollection {
  id: string;
  name: string;
  chain: string;
  contractAddress: string;
  imageUrl: string | null;
  supply: number | null;
  floorPrice: number | null;
  holderCount: number | null;
  verificationStatus: CollectionVerificationStatus;
  mappingStatus: CollectionMappingStatus;
  proposedProjectId: string | null;
  mappingConfidence: string | null;
  verificationNotes: string | null;
  projectId: string;
}

interface ProjectListResponse {
  items: AdminProject[];
  total: number;
  page: number;
  limit: number;
}

const REVIEWABLE_STATUSES = new Set<CollectionVerificationStatus>(['tracked_unverified', 'pending_claim']);

export default function AdminCollectionsPage() {
  const { accessToken } = useAuth();
  const [collections, setCollections] = useState<AdminCollection[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectIdInput, setProjectIdInput] = useState<Record<string, string>>({});
  const [notesInput, setNotesInput] = useState<Record<string, string>>({});
  const [enriching, setEnriching] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<'pending' | 'tracked_unverified' | 'pending_claim' | 'suggested' | 'all'>('pending');

  const fetchData = async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);

    try {
      const data = await apiFetch<ProjectListResponse>('/admin/projects?page=1&limit=200', {
        token: accessToken,
      });

      setProjects(data.items.map((project) => ({ id: project.id, name: project.name })));

      const flattened = data.items.flatMap((project) =>
        project.collections
          .filter((collection) => REVIEWABLE_STATUSES.has(collection.verificationStatus) || collection.mappingStatus === 'suggested')
          .map((collection) => ({ ...collection, projectId: project.id })),
      );

      setCollections(flattened);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load review queue');
      setCollections([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [accessToken]);

  const queueStats = useMemo(() => {
    return {
      tracked: collections.filter((c) => c.verificationStatus === 'tracked_unverified').length,
      pendingClaim: collections.filter((c) => c.verificationStatus === 'pending_claim').length,
      suggested: collections.filter((c) => c.mappingStatus === 'suggested').length,
    };
  }, [collections]);

  const filteredCollections = useMemo(() => {
    if (filter === 'all') return collections;
    if (filter === 'pending') {
      return collections.filter((c) => c.verificationStatus === 'tracked_unverified' || c.verificationStatus === 'pending_claim');
    }
    if (filter === 'suggested') return collections.filter((c) => c.mappingStatus === 'suggested');
    return collections.filter((c) => c.verificationStatus === filter);
  }, [collections, filter]);

  const handleVerify = async (collection: AdminCollection) => {
    if (!accessToken) return;
    await adminVerifyCollection(
      collection.id,
      {
        notes: notesInput[collection.id] || undefined,
        projectId: projectIdInput[collection.id] || undefined,
      },
      accessToken,
    );
    await fetchData();
  };

  const handleReject = async (collection: AdminCollection) => {
    if (!accessToken) return;
    await adminRejectCollection(
      collection.id,
      { notes: notesInput[collection.id] || undefined },
      accessToken,
    );
    await fetchData();
  };

  const handleSuggest = async (collection: AdminCollection) => {
    if (!accessToken) return;
    const projectId = projectIdInput[collection.id]?.trim();
    if (!projectId) return;

    await adminSuggestProject(
      collection.id,
      {
        projectId,
        confidence: 0.7,
        notes: notesInput[collection.id] || undefined,
      },
      accessToken,
    );
    await fetchData();
  };

  const handleEnrich = async (collection: AdminCollection) => {
    if (!accessToken) return;
    setEnriching((prev) => ({ ...prev, [collection.id]: true }));
    
    try {
      const result = await adminEnrichCollection(collection.id, accessToken);
      if (!result.success) {
        setError(result.message || 'Enrichment failed');
      } else {
        await fetchData();
      }
    } catch (err: any) {
      const message = err?.data?.message || err?.message || 'Enrichment failed';
      setError(message);
    } finally {
      setEnriching((prev) => ({ ...prev, [collection.id]: false }));
    }
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Collections Review Queue</h2>
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-white"
          >
            <option value="pending">Pending</option>
            <option value="tracked_unverified">Tracked Unverified</option>
            <option value="pending_claim">Pending Claim</option>
            <option value="suggested">Suggested</option>
            <option value="all">All</option>
          </select>
          <button
            onClick={fetchData}
            className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-300 hover:text-white"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Tracked Unverified" value={queueStats.tracked} />
        <StatCard label="Pending Claim" value={queueStats.pendingClaim} />
        <StatCard label="Suggested Mapping" value={queueStats.suggested} />
      </div>

      {loading ? (
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
          <span className="text-gray-400">Loading queue...</span>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-4">
          <p className="text-sm text-red-200">{error}</p>
          <button onClick={fetchData} className="mt-3 rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600">Retry</button>
        </div>
      ) : filteredCollections.length === 0 ? (
        <p className="text-gray-500">No collections in this queue state.</p>
      ) : (
        <div className="space-y-3">
          {filteredCollections.map((c) => (
            <div key={c.id} className="rounded-xl border border-gray-800 p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  {c.imageUrl ? (
                    <img
                      src={c.imageUrl}
                      alt={c.name}
                      className="h-16 w-16 rounded-lg border border-gray-700 object-cover"
                    />
                  ) : (
                    <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-gray-700 bg-gray-900 text-xs text-gray-500">
                      No Image
                    </div>
                  )}
                  <div>
                    <h3 className="font-medium">{c.name}</h3>
                    <p className="text-sm text-gray-500">
                      {c.chain} · {truncateAddress(c.contractAddress)}
                      {isInvalidAddress(c.chain, c.contractAddress) && (
                        <span className="ml-2 rounded bg-red-900/50 px-1.5 py-0.5 text-[10px] text-red-300">
                          Invalid Address
                        </span>
                      )}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-400">
                      {c.supply && <span>Supply: {c.supply.toLocaleString()}</span>}
                      {c.holderCount && <span>· Holders: {c.holderCount.toLocaleString()}</span>}
                      {c.floorPrice && <span>· Floor: {c.floorPrice} ETH</span>}
                    </div>
                    {getExplorerLink(c.chain, c.contractAddress) && (
                      <a
                        href={getExplorerLink(c.chain, c.contractAddress)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block text-xs text-purple-400 hover:text-purple-300"
                      >
                        View on Explorer →
                      </a>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">
                    verification: {c.verificationStatus}
                  </span>
                  <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">
                    mapping: {c.mappingStatus}
                  </span>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Project ID (for suggest/approve)</label>
                  <input
                    value={projectIdInput[c.id] || ''}
                    onChange={(e) => setProjectIdInput((prev) => ({ ...prev, [c.id]: e.target.value }))}
                    placeholder="project UUID"
                    list="admin-project-options"
                    className="w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Notes</label>
                  <input
                    value={notesInput[c.id] || c.verificationNotes || ''}
                    onChange={(e) => setNotesInput((prev) => ({ ...prev, [c.id]: e.target.value }))}
                    placeholder="optional moderation note"
                    className="w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500"
                  />
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-gray-400 sm:grid-cols-2">
                <p>Confidence: {c.mappingConfidence ?? 'n/a'}</p>
                <p>Proposed project: {c.proposedProjectId ?? 'n/a'}</p>
              </div>

              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300">Payload preview</summary>
                <pre className="mt-2 overflow-x-auto rounded bg-gray-950 p-2 text-[11px] text-gray-300">{JSON.stringify({
                  id: c.id,
                  chain: c.chain,
                  contractAddress: c.contractAddress,
                  verificationStatus: c.verificationStatus,
                  mappingStatus: c.mappingStatus,
                  mappingConfidence: c.mappingConfidence,
                  verificationNotes: c.verificationNotes,
                  proposedProjectId: c.proposedProjectId,
                }, null, 2)}</pre>
              </details>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => handleVerify(c)}
                  className="rounded bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600"
                >
                  Approve
                </button>
                <button
                  onClick={() => handleReject(c)}
                  className="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600"
                >
                  Reject
                </button>
                <button
                  onClick={() => handleSuggest(c)}
                  disabled={!projectIdInput[c.id]?.trim()}
                  className="rounded bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Suggest Project
                </button>
                <button
                  onClick={() => handleEnrich(c)}
                  disabled={enriching[c.id]}
                  className="rounded border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 hover:border-purple-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {enriching[c.id] ? 'Re-enriching...' : 'Re-enrich Metadata'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <datalist id="admin-project-options">
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </datalist>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-gray-800 p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-100">{value.toLocaleString()}</p>
    </div>
  );
}

function isInvalidAddress(chain: string, address: string): boolean {
  const addr = address.toLowerCase();
  if (chain.toLowerCase() === 'solana') {
    // Solana addresses are base58, typically 32-44 chars
    return !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }
  // EVM chains need exactly 0x + 40 hex chars
  return !/^0x[a-f0-9]{40}$/.test(addr) || addr.length !== 42;
}

function getExplorerLink(chain: string, contractAddress: string): string | null {
  const chainLower = chain.toLowerCase();
  
  if (chainLower === 'ethereum') {
    return `https://etherscan.io/address/${contractAddress}`;
  }
  if (chainLower === 'base') {
    return `https://basescan.org/address/${contractAddress}`;
  }
  if (chainLower === 'polygon') {
    return `https://polygonscan.com/address/${contractAddress}`;
  }
  if (chainLower === 'abstract') {
    return `https://explorer.abs.xyz/address/${contractAddress}`;
  }
  if (chainLower === 'apechain') {
    return `https://apescan.io/address/${contractAddress}`;
  }
  if (chainLower === 'solana') {
    return `https://solscan.io/account/${contractAddress}`;
  }
  
  return null;
}
