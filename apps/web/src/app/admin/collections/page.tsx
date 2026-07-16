'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  adminRejectCollection,
  adminSuggestProject,
  adminVerifyCollection,
  adminEnrichCollection,
  adminIndexCollectionHolders,
  adminMarkCollectionAsSpam,
  adminMarkCollectionAsNotSpam,
  adminBulkCheckSpam,
  adminIndexHolderBacklog,
  adminGetHolderBacklogStatus,
  type HolderBacklogJob,
  adminCheckSpamRaw,
  adminDiscoverCollections,
  adminBulkMarkSpam,
  adminBulkVerify,
  adminBulkLinkProject,
  adminBulkEnrich,
  apiFetch,
  type CollectionMappingStatus,
  type CollectionVerificationStatus,
} from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { AddressDisplay } from '@/components/ui/address-display';
import { ConfirmModal } from '@/components/ui/confirm-modal';

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
  const [filter, setFilter] = useState<'pending' | 'tracked_unverified' | 'pending_claim' | 'suggested' | 'verified' | 'spam' | 'all'>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(200);
  const [totalResults, setTotalResults] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkActionInProgress, setBulkActionInProgress] = useState(false);
  const [showSpam, setShowSpam] = useState(false);
  const [hasProjectFilter, setHasProjectFilter] = useState<'all' | 'has' | 'none'>('all');
  const [chainFilter, setChainFilter] = useState<string>('all');
  const [indexedFilter, setIndexedFilter] = useState(false);

  
  // Modal states
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: React.ReactNode;
    onConfirm: () => void;
    variant?: 'default' | 'danger' | 'warning';
    confirmText?: string;
    loading?: boolean;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const fetchData = async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);

    try {
      // Build search params
      const params = new URLSearchParams();
      
      if (searchQuery.trim().length >= 2) {
        params.set('q', searchQuery);
      }
      
      params.set('limit', pageSize.toString());
      params.set('page', page.toString());
      
      // Apply filters
      if (hasProjectFilter === 'has') params.set('hasProject', 'true');
      if (hasProjectFilter === 'none') params.set('hasProject', 'false');
      
      if (chainFilter !== 'all') params.set('chain', chainFilter);
      
      if (indexedFilter) params.set('indexed', 'true');
      
      if (showSpam) params.set('spam', 'true');
      else params.set('spam', 'false');
      
      // Verification status filter
      if (filter === 'verified') params.set('verified', 'true');
      else if (filter !== 'all') params.set('verified', 'false');

      const results = await apiFetch<{
        items: AdminCollection[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
      }>(
        `/admin/collections/search?${params.toString()}`,
        { token: accessToken }
      );
      
      setCollections(results.items.map(c => ({ ...c, projectId: c.project?.id || '' })));
      setTotalResults(results.total);
      
      // Load projects for dropdown
      const projectsData = await apiFetch<ProjectListResponse>('/admin/projects?page=1&limit=200', {
        token: accessToken,
      });
      setProjects(projectsData.items.map((p) => ({ id: p.id, name: p.name })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load collections');
      setCollections([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [accessToken, filter, hasProjectFilter, chainFilter, indexedFilter, showSpam, searchQuery, page, pageSize]);

  const handleSearch = () => {
    fetchData();
  };

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
    
    setConfirmModal({
      isOpen: true,
      title: 'Index Holders',
      message: (
        <div className="space-y-3">
          <p>Index all holders for <strong className="text-white">{collection.name}</strong>?</p>
          <p className="text-sm text-gray-400">
            This will fetch data from {apiSource} and may take several minutes for large collections.
          </p>
          <dl className="space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-gray-500 min-w-[80px]">Chain:</dt>
              <dd className="text-white">{collection.chain}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-gray-500 min-w-[80px]">{collection.chain === 'solana' ? 'Collection:' : 'Contract:'}</dt>
              <dd className="font-mono text-xs text-white break-all">{collection.contractAddress}</dd>
            </div>
          </dl>
        </div>
      ),
      confirmText: 'Index Holders',
      variant: 'default',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, loading: true }));
        setIndexing((prev) => ({ ...prev, [collection.id]: true }));
        
        try {
          const result = await adminIndexCollectionHolders(collection.id, accessToken);
          if (!result.success) {
            toast.error(result.error || 'Indexing failed');
          } else {
            toast.success(`Successfully indexed ${result.holdersIndexed.toLocaleString()} holders for ${result.collection}`);
            await fetchData();
          }
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        } catch (err: any) {
          const message = err?.data?.message || err?.message || 'Indexing failed';
          toast.error(message);
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        } finally {
          setIndexing((prev) => ({ ...prev, [collection.id]: false }));
        }
      },
    });
  };

  const handleDiscoverCollections = async (collectionId: string) => {
    if (!accessToken) return;

    setConfirmModal({
      isOpen: true,
      title: 'Discover Collections',
      message: (
        <div className="space-y-3">
          <p>Discover new collections via holder overlap?</p>
          <div className="space-y-2 text-sm text-gray-400">
            <p>This will:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>Check what NFTs this collection's holders own</li>
              <li>Add any new collections to the database as unverified</li>
              <li>Run in the background (check server logs for progress)</li>
            </ul>
          </div>
        </div>
      ),
      confirmText: 'Discover',
      variant: 'default',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, loading: true }));
        
        try {
          const result = await adminDiscoverCollections(
            collectionId,
            {}, // no maxHolders — scan the full holder list
            accessToken
          );
          
          toast.success(result.message + ' Check server logs for progress.');
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        } catch (err: any) {
          const message = err?.data?.message || err?.message || 'Discovery failed';
          toast.error(message);
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        }
      },
    });
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
      toast.success(`Marked ${result.collection} as spam`);
      await fetchData();
    } catch (err: any) {
      toast.error(err?.data?.message || err?.message || 'Failed to mark as spam');
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
      toast.success(`Marked ${result.collection} as NOT spam and added to allowlist`);
      await fetchData();
    } catch (err: any) {
      toast.error(err?.data?.message || err?.message || 'Failed to mark as not spam');
    }
  };

  const [backlogJob, setBacklogJob] = useState<HolderBacklogJob | null>(null);

  const refreshBacklogStatus = async () => {
    if (!accessToken) return;
    try {
      setBacklogJob(await adminGetHolderBacklogStatus(accessToken));
    } catch {
      // status is a nice-to-have; ignore fetch failures
    }
  };

  useEffect(() => {
    refreshBacklogStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  useEffect(() => {
    if (backlogJob?.status !== 'running') return;
    const interval = setInterval(refreshBacklogStatus, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backlogJob?.status, accessToken]);

  const handleIndexBacklog = async () => {
    if (!accessToken) return;

    setConfirmModal({
      isOpen: true,
      title: 'Index Holder Backlog',
      message: `Index holders for ${backlogJob?.queueSize != null ? backlogJob.queueSize.toLocaleString() : 'every'} collection${backlogJob?.queueSize === 1 ? '' : 's'} with no holder data yet (non-spam, not rejected/suppressed), strongest discovery overlap first. Runs as a background job (~1s per collection); check server logs for progress.`,
      confirmText: 'Start Indexing',
      loading: false,
      onConfirm: async () => {
        try {
          setConfirmModal(prev => ({ ...prev, loading: true }));
          const result = await adminIndexHolderBacklog(accessToken);
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
          setBacklogJob(result.job);
          if (result.alreadyRunning) {
            toast.info(`Backlog indexing already running (${result.job.processed}/${result.job.total} done)`);
          } else {
            toast.success(`Backlog indexing started: ${result.job.total} collections queued`, {
              description: 'Running in background. Check server logs for progress.',
              duration: 5000,
            });
          }
        } catch (err: any) {
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
          toast.error(err?.data?.message || err?.message || 'Failed to start backlog indexing');
        }
      },
    });
  };

  const handleBulkCheckSpam = async () => {
    if (!accessToken) return;

    setConfirmModal({
      isOpen: true,
      title: 'Check All Collections for Spam',
      message: 'This runs as a background job via Alchemy API and may take 5-10 minutes. Check server logs for progress.',
      confirmText: 'Start Spam Check',
      loading: false,
      onConfirm: async () => {
        try {
          setConfirmModal(prev => ({ ...prev, loading: true }));
          setBulkChecking(true);
          
          const result = await adminBulkCheckSpam(accessToken);
          
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
          setBulkChecking(false);
          
          toast.success(result.message, {
            description: 'Running in background. Refresh in a few minutes to see results.',
            duration: 5000,
          });
        } catch (err: any) {
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
          setBulkChecking(false);
          toast.error(err?.data?.message || err?.message || 'Failed to start bulk spam check');
        }
      },
      onCancel: () => setConfirmModal(prev => ({ ...prev, isOpen: false })),
    });
  };

  const handleDebugSpam = async (collection: AdminCollection) => {
    if (!accessToken) return;

    try {
      const result = await adminCheckSpamRaw(collection.id, accessToken);
      console.log('Raw spam check result:', result);
      
      const spamData = result.spamClassifications;
      if (spamData) {
        toast.info(`Spam data for ${collection.name}`, {
          description: `Is Spam: ${spamData.isSpam} | Classifications: ${spamData.classifications?.join(', ') || 'none'}`,
          duration: 8000,
        });
      } else {
        toast.info(`No spam data returned`, {
          description: `Status: ${result.responseStatus}. Check console for details.`,
          duration: 5000,
        });
      }
    } catch (err: any) {
      console.error('Debug spam check error:', err);
      toast.error(err?.data?.message || err?.message || 'Failed to check spam');
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

    setConfirmModal({
      isOpen: true,
      title: 'Mark as Spam',
      message: `Mark ${selectedIds.size} selected collection(s) as SPAM? This will hide them from the main feed.`,
      confirmText: 'Mark as Spam',
      loading: false,
      onConfirm: async () => {
        try {
          setConfirmModal(prev => ({ ...prev, loading: true }));
          setBulkActionInProgress(true);

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

          setConfirmModal(prev => ({ ...prev, isOpen: false }));
          setBulkActionInProgress(false);
          setSelectedIds(new Set());
          
          toast.success(`Bulk spam marking complete`, {
            description: `Succeeded: ${succeeded} | Failed: ${failed}`,
          });
          await fetchData();
        } catch (err: any) {
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
          setBulkActionInProgress(false);
          toast.error('Bulk operation failed');
        }
      },
      onCancel: () => setConfirmModal(prev => ({ ...prev, isOpen: false })),
    });
  };

  const handleBulkMarkNotSpam = async () => {
    if (!accessToken || selectedIds.size === 0) return;

    setConfirmModal({
      isOpen: true,
      title: 'Mark as NOT Spam',
      message: `Mark ${selectedIds.size} selected collection(s) as NOT SPAM? This will add them to the allowlist.`,
      confirmText: 'Mark as NOT Spam',
      loading: false,
      onConfirm: async () => {
        try {
          setConfirmModal(prev => ({ ...prev, loading: true }));
          setBulkActionInProgress(true);

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

          setConfirmModal(prev => ({ ...prev, isOpen: false }));
          setBulkActionInProgress(false);
          setSelectedIds(new Set());
          
          toast.success(`Bulk verification complete`, {
            description: `Succeeded: ${succeeded} | Failed: ${failed}`,
          });
          await fetchData();
        } catch (err: any) {
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
          setBulkActionInProgress(false);
          toast.error('Bulk operation failed');
        }
      },
      onCancel: () => setConfirmModal(prev => ({ ...prev, isOpen: false })),
    });
  };

  const [linkProjectId, setLinkProjectId] = useState('');
  const [showLinkModal, setShowLinkModal] = useState(false);

  const handleBulkLinkProject = async () => {
    if (!accessToken || !linkProjectId || selectedIds.size === 0) return;

    setConfirmModal({
      isOpen: true,
      title: 'Link Collections to Project',
      message: (
        <div>
          <p>Link {selectedIds.size} collection(s) to this project?</p>
          <p className="mt-2 text-sm text-gray-400">
            Project: {projects.find(p => p.id === linkProjectId)?.name || linkProjectId}
          </p>
        </div>
      ),
      confirmText: 'Link',
      variant: 'default',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, loading: true }));
        setBulkActionInProgress(true);
        
        try {
          const result = await adminBulkLinkProject(
            Array.from(selectedIds),
            linkProjectId,
            accessToken
          );
          
          toast.success(`Linked ${result.success} collections to ${result.projectName}`);
          if (result.failed > 0) {
            toast.error(`${result.failed} failed: ${result.errors.slice(0, 3).join(', ')}`);
          }
          
          setSelectedIds(new Set());
          setLinkProjectId('');
          setShowLinkModal(false);
          await fetchData();
        } catch (err: any) {
          toast.error(err?.message || 'Bulk link failed');
        } finally {
          setBulkActionInProgress(false);
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        }
      },
    });
  };

  const handleBulkVerifyNew = async () => {
    if (!accessToken || selectedIds.size === 0) return;

    setConfirmModal({
      isOpen: true,
      title: 'Verify Collections',
      message: `Verify ${selectedIds.size} collection(s)?`,
      confirmText: 'Verify',
      variant: 'default',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, loading: true }));
        setBulkActionInProgress(true);
        
        try {
          const result = await adminBulkVerify(Array.from(selectedIds), accessToken);
          
          toast.success(`Verified ${result.success} collections`);
          if (result.failed > 0) {
            toast.error(`${result.failed} failed`);
          }
          
          setSelectedIds(new Set());
          await fetchData();
        } catch (err: any) {
          toast.error(err?.message || 'Bulk verify failed');
        } finally {
          setBulkActionInProgress(false);
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        }
      },
    });
  };

  const handleBulkSpamNew = async () => {
    if (!accessToken || selectedIds.size === 0) return;

    setConfirmModal({
      isOpen: true,
      title: 'Mark as Spam',
      message: `Mark ${selectedIds.size} collection(s) as spam?`,
      confirmText: 'Mark Spam',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, loading: true }));
        setBulkActionInProgress(true);
        
        try {
          const result = await adminBulkMarkSpam(Array.from(selectedIds), accessToken);
          
          toast.success(`Marked ${result.success} collections as spam`);
          if (result.failed > 0) {
            toast.error(`${result.failed} failed`);
          }
          
          setSelectedIds(new Set());
          await fetchData();
        } catch (err: any) {
          toast.error(err?.message || 'Bulk spam failed');
        } finally {
          setBulkActionInProgress(false);
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        }
      },
    });
  };

  const handleBulkEnrich = async () => {
    if (!accessToken || selectedIds.size === 0) return;

    setConfirmModal({
      isOpen: true,
      title: 'Refresh Metadata',
      message: (
        <div>
          <p>Re-fetch blockchain metadata for {selectedIds.size} collection(s)?</p>
          <p className="mt-2 text-sm text-gray-400">
            This runs in the background. Check server logs for progress.
          </p>
        </div>
      ),
      confirmText: 'Start Refresh',
      variant: 'default',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, loading: true }));
        
        try {
          const result = await adminBulkEnrich(Array.from(selectedIds), accessToken);
          
          toast.success(`${result.message} Refresh the page in a few minutes to see updated metadata.`);
          
          setSelectedIds(new Set());
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        } catch (err: any) {
          toast.error(err?.message || 'Failed to start bulk enrich');
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        }
      },
    });
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
            value={hasProjectFilter}
            onChange={(e) => setHasProjectFilter(e.target.value as typeof hasProjectFilter)}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-white"
          >
            <option value="all">All Collections</option>
            <option value="has">✓ Has Project</option>
            <option value="none">⚠️ No Project</option>
          </select>

          <select
            value={chainFilter}
            onChange={(e) => setChainFilter(e.target.value)}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-white"
          >
            <option value="all">All Chains</option>
            <option value="ethereum">Ethereum</option>
            <option value="base">Base</option>
            <option value="polygon">Polygon</option>
            <option value="solana">Solana</option>
            <option value="abstract">Abstract</option>
            <option value="apechain">ApeChain</option>
            <option value="arbitrum">Arbitrum</option>
            <option value="optimism">Optimism</option>
            <option value="avalanche">Avalanche</option>
          </select>

          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-white"
          >
            <option value="all">All Status</option>
            <option value="verified">✓ Verified</option>
            <option value="tracked_unverified">Unverified</option>
            <option value="pending">Pending Review</option>
          </select>

          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={indexedFilter}
              onChange={(e) => setIndexedFilter(e.target.checked)}
              className="rounded border-gray-700 bg-gray-900 text-purple-600 focus:ring-purple-500"
            />
            Indexed only
          </label>

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
          <button
            onClick={handleIndexBacklog}
            disabled={backlogJob?.status === 'running'}
            className="rounded bg-emerald-700 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
            title="Index holders for all non-spam collections with no holder data yet"
          >
            {backlogJob?.status === 'running'
              ? `⏳ Indexing ${backlogJob.processed}/${backlogJob.total}...`
              : `📥 Index Holder Backlog${backlogJob?.queueSize != null ? ` (${backlogJob.queueSize.toLocaleString()})` : ''}`}
          </button>
        </div>

        {/* Bulk Actions Bar */}
        {selectedIds.size > 0 && (
          <div className="flex flex-col gap-3 rounded-xl border border-purple-900/50 bg-purple-950/30 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-purple-200">
                {selectedIds.size} collection{selectedIds.size !== 1 ? 's' : ''} selected
              </span>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-300 hover:text-white"
              >
                Clear All
              </button>
            </div>
            
            <div className="flex flex-wrap gap-2">
              <div className="flex gap-2">
                <select
                  value={linkProjectId}
                  onChange={(e) => setLinkProjectId(e.target.value)}
                  className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-white"
                >
                  <option value="">Select Project...</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <button
                  onClick={handleBulkLinkProject}
                  disabled={bulkActionInProgress || !linkProjectId}
                  className="rounded bg-blue-700 px-3 py-1 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Link to Project
                </button>
              </div>

              <button
                onClick={handleBulkVerifyNew}
                disabled={bulkActionInProgress}
                className="rounded bg-green-700 px-3 py-1 text-sm font-medium text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ✓ Verify
              </button>

              <button
                onClick={handleBulkEnrich}
                disabled={bulkActionInProgress}
                className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                🔄 Refresh Metadata
              </button>

              <button
                onClick={handleBulkSpamNew}
                disabled={bulkActionInProgress}
                className="rounded bg-red-700 px-3 py-1 text-sm font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                🚫 Mark Spam
              </button>
            </div>
          </div>
        )}
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
          {/* Pagination Controls */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-800 bg-gray-900/50 p-3">
            <div className="flex items-center gap-3 text-sm text-gray-300">
              <span>
                Showing {filteredCollections.length} of {totalResults.toLocaleString()} total
              </span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(parseInt(e.target.value));
                  setPage(1);
                }}
                className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-white"
              >
                <option value="50">50 per page</option>
                <option value="100">100 per page</option>
                <option value="200">200 per page</option>
                <option value="500">500 per page</option>
              </select>
            </div>
            
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(1)}
                disabled={page === 1}
                className="rounded bg-gray-800 px-3 py-1 text-sm text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                First
              </button>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="rounded bg-gray-800 px-3 py-1 text-sm text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ← Prev
              </button>
              <span className="px-3 text-sm text-gray-300">
                Page {page} of {Math.ceil(totalResults / pageSize)}
              </span>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={page >= Math.ceil(totalResults / pageSize)}
                className="rounded bg-gray-800 px-3 py-1 text-sm text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next →
              </button>
              <button
                onClick={() => setPage(Math.ceil(totalResults / pageSize))}
                disabled={page >= Math.ceil(totalResults / pageSize)}
                className="rounded bg-gray-800 px-3 py-1 text-sm text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Last
              </button>
            </div>
          </div>

          {/* Select All */}
          <div className="mb-3 flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={selectedIds.size > 0 && selectedIds.size === filteredCollections.length}
              onChange={handleSelectAll}
              className="rounded border-gray-700 bg-gray-900 text-purple-600 focus:ring-purple-500"
            />
            <label>Select all {filteredCollections.length} on this page</label>
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
                      {c.chain} · <AddressDisplay address={c.contractAddress} chain={c.chain} className="text-sm text-gray-500" />
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
                <Link
                  href={`/admin/collections/${c.id}/holder-history`}
                  className="rounded border border-purple-700 px-3 py-1.5 text-xs font-medium text-purple-300 hover:border-purple-500 hover:text-white"
                  title="View full holder history"
                >
                  📈 Holder History
                </Link>
                <button
                  onClick={() => handleDiscoverCollections(c.id)}
                  className="rounded bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600"
                  title="Discover new collections via holder overlap"
                >
                  🔍 Discover
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

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={confirmModal.onConfirm}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        variant={confirmModal.variant}
        loading={confirmModal.loading}
      />
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
