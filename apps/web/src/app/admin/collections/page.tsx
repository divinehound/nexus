'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  adminRejectCollection,
  adminSuggestProject,
  adminVerifyCollection,
  adminEnrichCollection,
  adminIndexCollectionHolders,
  adminMarkCollectionAsSpam,
  adminMarkCollectionAsNotSpam,
  adminBulkCheckSpam,
  adminCheckSpamRaw,
  adminDiscoverCollections,
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
  lastIndexFinishedAt?: string | null;
  lastIndexStatus?: string | null;
  indexStatus?: string | null;
  isSpam?: boolean;
  spamScore?: number | null;
  spamReason?: string | null;
  spamDetectedBy?: string | null;
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
  const [indexing, setIndexing] = useState<Record<string, boolean>>({});
  const [bulkChecking, setBulkChecking] = useState(false);
  const [filter, setFilter] = useState<'pending' | 'tracked_unverified' | 'pending_claim' | 'suggested' | 'verified' | 'spam' | 'all'>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkActionInProgress, setBulkActionInProgress] = useState(false);
  const [showSpam, setShowSpam] = useState(false);
  const [directLookup, setDirectLookup] = useState({ chain: 'solana', address: '' });
  const [lookupResult, setLookupResult] = useState<AdminCollection | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const fetchData = async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);

    try {
      // If search query exists and is long enough, use search endpoint
      if (searchQuery.trim().length >= 2) {
        const results = await apiFetch<AdminCollection[]>(
          `/admin/collections/search?q=${encodeURIComponent(searchQuery)}&limit=100`,
          { token: accessToken }
        );
        setCollections(results.map(c => ({ ...c, projectId: c.project?.id || '' })));
        setProjects([]);
      } else {
        // Otherwise load via projects endpoint
        const data = await apiFetch<ProjectListResponse>('/admin/projects?page=1&limit=200', {
          token: accessToken,
        });

        setProjects(data.items.map((project) => ({ id: project.id, name: project.name })));

        const flattened = data.items.flatMap((project) =>
          project.collections.map((collection) => ({ ...collection, projectId: project.id })),
        );

        setCollections(flattened);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load review queue');
      setCollections([]);
    } finally {
      setLoading(false);
    }
  };

  const handleDirectLookup = async () => {
    if (!accessToken || !directLookup.address.trim()) return;
    setLookupError(null);
    setLookupResult(null);

    try {
      const result = await apiFetch<AdminCollection>(
        `/collections/${directLookup.chain}/${directLookup.address}`,
        { token: accessToken }
      );
      setLookupResult(result);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Collection not found');
    }
  };

  useEffect(() => {
    fetchData();
  }, [accessToken]);

  const handleSearch = () => {
    fetchData();
  };

  const queueStats = useMemo(() => {
    return {
      tracked: collections.filter((c) => c.verificationStatus === 'tracked_unverified').length,
      pendingClaim: collections.filter((c) => c.verificationStatus === 'pending_claim').length,
      suggested: collections.filter((c) => c.mappingStatus === 'suggested').length,
      verified: collections.filter((c) => c.verificationStatus === 'verified').length,
      spam: collections.filter((c) => c.isSpam === true).length,
      all: collections.length,
    };
  }, [collections]);

  const filteredCollections = useMemo(() => {
    let filtered = collections;
    
    // Apply spam filter first
    if (!showSpam) {
      filtered = filtered.filter((c) => !c.isSpam);
    }
    
    // Apply status filter
    if (filter === 'pending') {
      filtered = filtered.filter((c) => c.verificationStatus === 'tracked_unverified' || c.verificationStatus === 'pending_claim');
    } else if (filter === 'suggested') {
      filtered = filtered.filter((c) => c.mappingStatus === 'suggested');
    } else if (filter === 'verified') {
      filtered = filtered.filter((c) => c.verificationStatus === 'verified');
    } else if (filter === 'spam') {
      filtered = filtered.filter((c) => c.isSpam === true);
    } else if (filter !== 'all') {
      filtered = filtered.filter((c) => c.verificationStatus === filter);
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((c) => 
        c.name.toLowerCase().includes(query) ||
        c.contractAddress.toLowerCase().includes(query) ||
        c.chain.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [collections, filter, searchQuery, showSpam]);

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

  const handleIndexHolders = async (collection: AdminCollection) => {
    if (!accessToken) return;

    const apiSource = collection.chain === 'solana' ? 'Helius' : 'Alchemy';
    const confirmed = window.confirm(
      `Index all holders for ${collection.name}?\n\nThis will fetch data from ${apiSource} and may take several minutes for large collections.\n\nChain: ${collection.chain}\n${collection.chain === 'solana' ? 'Collection' : 'Contract'}: ${collection.contractAddress}`
    );
    
    if (!confirmed) return;

    setIndexing((prev) => ({ ...prev, [collection.id]: true }));
    
    try {
      const result = await adminIndexCollectionHolders(collection.id, accessToken);
      if (!result.success) {
        setError(result.error || 'Indexing failed');
      } else {
        alert(`✅ Successfully indexed ${result.holdersIndexed.toLocaleString()} holders for ${result.collection}!`);
        await fetchData();
      }
    } catch (err: any) {
      const message = err?.data?.message || err?.message || 'Indexing failed';
      setError(message);
    } finally {
      setIndexing((prev) => ({ ...prev, [collection.id]: false }));
    }
  };

  const handleDiscoverCollections = async (collectionId: string) => {
    if (!accessToken) return;

    const confirmed = window.confirm(
      `Discover new collections via holder overlap?\n\nThis will:\n- Check what NFTs this collection's holders own\n- Add any new collections to the database as unverified\n- Run in the background (check server logs for progress)\n\nContinue?`
    );
    
    if (!confirmed) return;

    try {
      const result = await adminDiscoverCollections(
        collectionId,
        { maxHolders: 100, maxCollectionsPerHolder: 50 },
        accessToken
      );
      
      alert(`✅ ${result.message}\n\nCheck server logs for progress and results.`);
    } catch (err: any) {
      const message = err?.data?.message || err?.message || 'Discovery failed';
      setError(message);
    }
  };

  const handleMarkSpam = async (collection: AdminCollection) => {
    if (!accessToken) return;

    const notes = window.prompt(
      `Mark "${collection.name}" as spam?\n\nOptional reason:`,
      'manually_flagged'
    );
    if (notes === null) return; // User cancelled

    try {
      const result = await adminMarkCollectionAsSpam(collection.id, notes || undefined, accessToken);
      alert(`✅ Marked ${result.collection} as spam`);
      await fetchData();
    } catch (err: any) {
      setError(err?.data?.message || err?.message || 'Failed to mark as spam');
    }
  };

  const handleMarkNotSpam = async (collection: AdminCollection) => {
    if (!accessToken) return;

    const reason = window.prompt(
      `Mark "${collection.name}" as NOT spam?\n\nThis will add it to the allowlist.\n\nReason:`,
      'verified_legitimate'
    );
    if (reason === null) return; // User cancelled

    try {
      const result = await adminMarkCollectionAsNotSpam(collection.id, reason || undefined, accessToken);
      alert(`✅ Marked ${result.collection} as NOT spam and added to allowlist`);
      await fetchData();
    } catch (err: any) {
      setError(err?.data?.message || err?.message || 'Failed to mark as not spam');
    }
  };

  const handleBulkCheckSpam = async () => {
    if (!accessToken) return;

    const confirmed = window.confirm(
      'Check ALL collections for spam via Alchemy API?\n\n' +
      'This runs as a background job and may take 5-10 minutes.\n' +
      'Check server logs for progress and completion.\n\n' +
      'Continue?'
    );
    if (!confirmed) return;

    setBulkChecking(true);
    setError(null);

    try {
      const result = await adminBulkCheckSpam(accessToken);
      alert(
        `✅ ${result.message}\n\n` +
        'The spam check is running in the background.\n' +
        'Refresh the page in a few minutes to see results.'
      );
      setBulkChecking(false);
    } catch (err: any) {
      setError(err?.data?.message || err?.message || 'Failed to start bulk spam check');
      setBulkChecking(false);
    }
  };

  const handleDebugSpam = async (collection: AdminCollection) => {
    if (!accessToken) return;

    try {
      const result = await adminCheckSpamRaw(collection.id, accessToken);
      console.log('Raw spam check result:', result);
      
      const spamData = result.spamClassifications;
      if (spamData) {
        alert(
          `Spam Data for ${collection.name}:\n\n` +
          `Is Spam: ${spamData.isSpam}\n` +
          `Classifications: ${spamData.classifications?.join(', ') || 'none'}\n\n` +
          `Full data logged to console`
        );
      } else {
        alert(
          `No spam data returned for ${collection.name}\n\n` +
          `Response status: ${result.responseStatus}\n` +
          `Full response logged to console`
        );
      }
    } catch (err: any) {
      console.error('Debug spam check error:', err);
      alert(`Error: ${err?.data?.message || err?.message || 'Failed to check spam'}`);
    }
  };

  // Bulk selection handlers
  const handleToggleSelect = (collectionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(collectionId)) {
        next.delete(collectionId);
      } else {
        next.add(collectionId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedIds.size === filteredCollections.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredCollections.map((c) => c.id)));
    }
  };

  const handleBulkMarkSpam = async () => {
    if (!accessToken || selectedIds.size === 0) return;

    const confirmed = window.confirm(
      `Mark ${selectedIds.size} selected collection(s) as SPAM?\n\nThis will hide them from the main feed.`
    );
    if (!confirmed) return;

    setBulkActionInProgress(true);
    setError(null);

    let succeeded = 0;
    let failed = 0;

    for (const id of selectedIds) {
      try {
        await adminMarkCollectionAsSpam(id, 'bulk_manual_review', accessToken);
        succeeded++;
      } catch (err) {
        failed++;
      }
    }

    setBulkActionInProgress(false);
    setSelectedIds(new Set());
    
    alert(`✅ Bulk spam marking complete!\n\nSucceeded: ${succeeded}\nFailed: ${failed}`);
    await fetchData();
  };

  const handleBulkMarkNotSpam = async () => {
    if (!accessToken || selectedIds.size === 0) return;

    const confirmed = window.confirm(
      `Mark ${selectedIds.size} selected collection(s) as NOT SPAM?\n\nThis will add them to the allowlist.`
    );
    if (!confirmed) return;

    setBulkActionInProgress(true);
    setError(null);

    let succeeded = 0;
    let failed = 0;

    for (const id of selectedIds) {
      try {
        await adminMarkCollectionAsNotSpam(id, 'bulk_verified_legitimate', accessToken);
        succeeded++;
      } catch (err) {
        failed++;
      }
    }

    setBulkActionInProgress(false);
    setSelectedIds(new Set());
    
    alert(`✅ Bulk verification complete!\n\nSucceeded: ${succeeded}\nFailed: ${failed}`);
    await fetchData();
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Collections Review Queue</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Search by name or contract..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="w-64 rounded border border-gray-700 bg-gray-900 px-3 py-1 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none"
            />
            <button
              onClick={handleSearch}
              className="rounded bg-purple-700 px-3 py-1 text-sm font-medium text-white hover:bg-purple-600"
            >
              Search
            </button>
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  fetchData();
                }}
                className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-400 hover:text-white"
              >
                Clear
              </button>
            )}
          </div>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-white"
          >
            <option value="pending">Pending Review</option>
            <option value="tracked_unverified">Tracked Unverified</option>
            <option value="pending_claim">Pending Claim</option>
            <option value="suggested">Suggested Mapping</option>
            <option value="verified">Verified ✓</option>
            <option value="spam">🚫 Spam Only</option>
            <option value="all">All Collections</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={showSpam}
              onChange={(e) => setShowSpam(e.target.checked)}
              className="rounded border-gray-700 bg-gray-900 text-purple-600 focus:ring-purple-500"
            />
            Show spam
          </label>
          <button
            onClick={fetchData}
            className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-300 hover:text-white"
          >
            Refresh
          </button>
          <button
            onClick={handleBulkCheckSpam}
            disabled={bulkChecking}
            className="rounded bg-red-700 px-3 py-1 text-sm font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
            title="Check all collections via Alchemy API and auto-flag spam"
          >
            {bulkChecking ? '⏳ Checking...' : '🔍 Bulk Check Spam'}
          </button>
        </div>

        {/* Direct Collection Lookup */}
        <div className="rounded-xl border border-blue-900/50 bg-blue-950/30 p-4">
          <h3 className="mb-2 text-sm font-medium text-blue-200">Direct Collection Lookup</h3>
          <p className="mb-3 text-xs text-gray-400">
            Find collections not yet mapped to projects (e.g., Solana Deads)
          </p>
          <div className="flex gap-2">
            <select
              value={directLookup.chain}
              onChange={(e) => setDirectLookup({ ...directLookup, chain: e.target.value })}
              className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
            >
              <option value="solana">Solana</option>
              <option value="ethereum">Ethereum</option>
              <option value="base">Base</option>
              <option value="polygon">Polygon</option>
            </select>
            <input
              type="text"
              value={directLookup.address}
              onChange={(e) => setDirectLookup({ ...directLookup, address: e.target.value })}
              placeholder="Contract address"
              className="flex-1 rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500"
            />
            <button
              onClick={handleDirectLookup}
              disabled={!directLookup.address.trim()}
              className="rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
            >
              Lookup
            </button>
          </div>
          {lookupError && (
            <div className="mt-2 text-sm text-red-400">{lookupError}</div>
          )}
          {lookupResult && (
            <div className="mt-3 rounded border border-gray-800 bg-gray-900 p-3">
              <div className="mb-2 flex items-start justify-between">
                <div>
                  <h4 className="font-medium text-white">{lookupResult.name}</h4>
                  <p className="text-xs text-gray-500">{lookupResult.chain} · {truncateAddress(lookupResult.contractAddress)}</p>
                </div>
                {lookupResult.imageUrl && (
                  <img src={lookupResult.imageUrl} alt={lookupResult.name} className="h-12 w-12 rounded border border-gray-700 object-cover" />
                )}
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => handleIndexHolders(lookupResult)}
                  disabled={indexing[lookupResult.id]}
                  className="rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50"
                >
                  {indexing[lookupResult.id] ? '⏳ Indexing...' : '🔄 Index Holders'}
                </button>
                <button
                  onClick={() => handleDiscoverCollections(lookupResult.id)}
                  className="rounded bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-600"
                  title="Find new collections via holder overlap"
                >
                  🔍 Discover
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Bulk Actions Bar */}
        {selectedIds.size > 0 && (
          <div className="flex items-center justify-between rounded-xl border border-purple-900/50 bg-purple-950/30 p-3">
            <span className="text-sm font-medium text-purple-200">
              {selectedIds.size} collection{selectedIds.size !== 1 ? 's' : ''} selected
            </span>
            <div className="flex gap-2">
              <button
                onClick={handleBulkMarkSpam}
                disabled={bulkActionInProgress}
                className="rounded bg-red-700 px-3 py-1 text-sm font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {bulkActionInProgress ? '⏳ Processing...' : '🚫 Mark as Spam'}
              </button>
              <button
                onClick={handleBulkMarkNotSpam}
                disabled={bulkActionInProgress}
                className="rounded bg-green-700 px-3 py-1 text-sm font-medium text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {bulkActionInProgress ? '⏳ Processing...' : '✓ Mark as NOT Spam'}
              </button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-300 hover:text-white"
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <StatCard label="Tracked Unverified" value={queueStats.tracked} />
        <StatCard label="Pending Claim" value={queueStats.pendingClaim} />
        <StatCard label="Suggested Mapping" value={queueStats.suggested} />
        <StatCard label="Verified" value={queueStats.verified} />
        <StatCard label="🚫 Spam" value={queueStats.spam} />
        <StatCard label="Total" value={queueStats.all} />
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
        <>
          {/* Select All */}
          <div className="mb-3 flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={selectedIds.size > 0 && selectedIds.size === filteredCollections.length}
              onChange={handleSelectAll}
              className="rounded border-gray-700 bg-gray-900 text-purple-600 focus:ring-purple-500"
            />
            <label>Select all {filteredCollections.length} visible collections</label>
          </div>

          <div className="space-y-3">
            {filteredCollections.map((c) => (
              <div key={c.id} className="rounded-xl border border-gray-800 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    {/* Checkbox */}
                    <input
                      type="checkbox"
                      checked={selectedIds.has(c.id)}
                      onChange={() => handleToggleSelect(c.id)}
                      className="mt-1 rounded border-gray-700 bg-gray-900 text-purple-600 focus:ring-purple-500"
                    />
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
                    {c.lastIndexFinishedAt && (
                      <div className="mt-1 text-xs text-gray-500">
                        Last indexed: {new Date(c.lastIndexFinishedAt).toLocaleString()} 
                        {c.lastIndexStatus && (
                          <span className={c.lastIndexStatus === 'success' ? 'text-green-400' : 'text-red-400'}>
                            {' '}({c.lastIndexStatus})
                          </span>
                        )}
                        {c.indexStatus && c.indexStatus !== 'nexus_only' && (
                          <span className="ml-2 rounded bg-purple-900/50 px-1.5 py-0.5 text-purple-300">
                            {c.indexStatus}
                          </span>
                        )}
                      </div>
                    )}
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
                  {c.isSpam && (
                    <span className="rounded bg-red-900/50 px-2 py-1 text-red-300 font-medium">
                      🚫 SPAM
                      {c.spamScore && <span className="ml-1">({c.spamScore})</span>}
                      {c.spamDetectedBy && <span className="ml-1 text-red-400/70">· {c.spamDetectedBy}</span>}
                    </span>
                  )}
                  {c.spamScore && c.spamScore > 0 && !c.isSpam && (
                    <span className="rounded bg-yellow-900/50 px-2 py-1 text-yellow-300">
                      ⚠️ Score: {c.spamScore}
                    </span>
                  )}
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
                <button
                  onClick={() => handleIndexHolders(c)}
                  disabled={indexing[c.id]}
                  className="rounded border border-orange-700 px-3 py-1.5 text-xs font-medium text-orange-300 hover:border-orange-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  title="Index all holders from blockchain"
                >
                  {indexing[c.id] ? 'Indexing...' : '🔍 Index Holders'}
                </button>
                {c.isSpam ? (
                  <button
                    onClick={() => handleMarkNotSpam(c)}
                    className="rounded border border-green-700 px-3 py-1.5 text-xs font-medium text-green-300 hover:border-green-500 hover:text-white"
                    title="Remove from spam list and add to allowlist"
                  >
                    ✓ Not Spam
                  </button>
                ) : (
                  <button
                    onClick={() => handleMarkSpam(c)}
                    className="rounded border border-red-700 px-3 py-1.5 text-xs font-medium text-red-300 hover:border-red-500 hover:text-white"
                    title="Mark as spam and hide from public views"
                  >
                    🚫 Mark Spam
                  </button>
                )}
                <button
                  onClick={() => handleDebugSpam(c)}
                  className="rounded border border-yellow-700 px-3 py-1.5 text-xs font-medium text-yellow-300 hover:border-yellow-500 hover:text-white"
                  title="Check raw spam data from Alchemy API"
                >
                  🐛 Debug Spam
                </button>
              </div>
            </div>
          ))}
          </div>
        </>
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
