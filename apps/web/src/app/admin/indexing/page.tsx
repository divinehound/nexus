'use client';

import { useEffect, useState } from 'react';
import {
  type AdminIndexingJobDetails,
  type AdminIndexingJobListItem,
  type AdminIndexStatusResponse,
  type IndexingJobStatus,
  getAdminCollectionIndexStatus,
  getAdminIndexingJob,
  getAdminIndexingJobs,
  getAdminProjectIndexStatus,
  getAdminWalletIndexStatus,
  refreshAdminCollectionIndexing,
  refreshAdminProjectIndexing,
  refreshAdminWalletIndexing,
  retryAdminIndexingJob,
} from '@/lib/api';
import { useAuth } from '@/context/auth-context';

const statusOptions: Array<{ label: string; value: '' | IndexingJobStatus }> = [
  { label: 'All', value: '' },
  { label: 'Queued', value: 'queued' },
  { label: 'Running', value: 'running' },
  { label: 'Done', value: 'completed' },
  { label: 'Failed', value: 'failed' },
];

function statusClass(status: string | null) {
  if (status === 'completed' || status === 'done') return 'bg-emerald-900/30 text-emerald-400';
  if (status === 'failed') return 'bg-red-900/30 text-red-400';
  if (status === 'running') return 'bg-amber-900/30 text-amber-400';
  if (status === 'queued') return 'bg-slate-800 text-slate-300';
  return 'bg-gray-900 text-gray-500';
}

function formatDate(value: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function formatDuration(durationMs: number | null) {
  if (!durationMs || durationMs < 0) return '-';
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function statsSummary(statsJson: Record<string, unknown> | null) {
  if (!statsJson) return '-';
  const holdings = Number(statsJson.holdingsDiscovered ?? 0);
  const active = Number(statsJson.active ?? 0);
  const lightweight = Number(statsJson.lightweight ?? 0);
  const suppressed = Number(statsJson.suppressed ?? 0);
  return `holdings ${holdings} · active ${active} · light ${lightweight} · suppressed ${suppressed}`;
}

function StatusPanel({
  title,
  placeholder,
  value,
  onChange,
  onLookup,
  onRefresh,
  status,
  loading,
  error,
}: {
  title: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onLookup: () => void;
  onRefresh: () => void;
  status: AdminIndexStatusResponse | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="rounded border border-gray-800 p-4">
      <h3 className="mb-3 text-sm font-medium text-white">{title}</h3>
      <div className="mb-3 flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
        />
        <button onClick={onLookup} className="rounded border border-gray-700 px-3 py-2 text-xs text-gray-200">
          Lookup
        </button>
        <button onClick={onRefresh} className="rounded border border-purple-700 px-3 py-2 text-xs text-purple-300">
          Reindex
        </button>
      </div>

      {loading ? (
        <p className="text-xs text-gray-400">Loading...</p>
      ) : error ? (
        <div className="text-xs text-red-300">
          <p>{error}</p>
          <button className="underline" onClick={onLookup}>Retry</button>
        </div>
      ) : status ? (
        <div className="space-y-1 text-xs text-gray-300">
          <div>
            <span className={`rounded px-2 py-1 ${statusClass(status.lastIndexStatus)}`}>
              {status.lastIndexStatus ?? 'unknown'}
            </span>
          </div>
          <div>Last started: {formatDate(status.lastIndexStartedAt)}</div>
          <div>Last finished: {formatDate(status.lastIndexFinishedAt)}</div>
          <div>Last indexed at: {formatDate(status.lastIndexFinishedAt)}</div>
          <div>Last job id: {status.lastIndexJobId ?? '-'}</div>
          <div className="text-red-300">Last error: {status.lastIndexError ?? '-'}</div>
        </div>
      ) : (
        <p className="text-xs text-gray-500">No status loaded yet.</p>
      )}
    </div>
  );
}

export default function AdminIndexingPage() {
  const { accessToken } = useAuth();
  const [jobs, setJobs] = useState<AdminIndexingJobListItem[]>([]);
  const [status, setStatus] = useState<'' | IndexingJobStatus>('');
  const [walletId, setWalletId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 20;

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminIndexingJobDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const [walletStatusInput, setWalletStatusInput] = useState('');
  const [collectionStatusInput, setCollectionStatusInput] = useState('');
  const [projectStatusInput, setProjectStatusInput] = useState('');

  const [walletStatus, setWalletStatus] = useState<AdminIndexStatusResponse | null>(null);
  const [collectionStatus, setCollectionStatus] = useState<AdminIndexStatusResponse | null>(null);
  const [projectStatus, setProjectStatus] = useState<AdminIndexStatusResponse | null>(null);

  const [walletStatusLoading, setWalletStatusLoading] = useState(false);
  const [collectionStatusLoading, setCollectionStatusLoading] = useState(false);
  const [projectStatusLoading, setProjectStatusLoading] = useState(false);

  const [walletStatusError, setWalletStatusError] = useState<string | null>(null);
  const [collectionStatusError, setCollectionStatusError] = useState<string | null>(null);
  const [projectStatusError, setProjectStatusError] = useState<string | null>(null);

  const loadJobs = () => {
    if (!accessToken) {
      setLoading(false);
      setError('Please connect your wallet and ensure this account is admin.');
      return;
    }
    setLoading(true);
    setError(null);

    getAdminIndexingJobs(accessToken, {
      status: status || undefined,
      walletId: walletId || undefined,
      page,
      limit,
    })
      .then((res) => {
        setJobs(res.items);
        setTotal(res.total);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load indexing jobs');
      })
      .finally(() => setLoading(false));
  };

  useEffect(loadJobs, [accessToken, status, walletId, page]);

  const openDetails = async (id: string) => {
    if (!accessToken) return;
    setSelectedId(id);
    setDetailsOpen(true);
    setDetailsLoading(true);
    setSelected(null);
    try {
      const data = await getAdminIndexingJob(id, accessToken);
      setSelected(data);
    } catch (err) {
      setSelected(null);
      setError(err instanceof Error ? err.message : 'Failed to load job details');
    } finally {
      setDetailsLoading(false);
    }
  };

  const retryJob = async (job: AdminIndexingJobListItem) => {
    if (!accessToken) return;
    if (!confirm(`Retry indexing job ${job.id}?`)) return;
    try {
      await retryAdminIndexingJob(job.id, accessToken);
      await loadJobs();
      if (selectedId === job.id) {
        await openDetails(job.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry job');
    }
  };

  const loadWalletStatus = async () => {
    if (!accessToken || !walletStatusInput) return;
    setWalletStatusLoading(true);
    setWalletStatusError(null);
    try {
      setWalletStatus(await getAdminWalletIndexStatus(walletStatusInput.trim(), accessToken));
    } catch (err) {
      setWalletStatusError(err instanceof Error ? err.message : 'Failed to fetch wallet status');
    } finally {
      setWalletStatusLoading(false);
    }
  };

  const loadCollectionStatus = async () => {
    if (!accessToken || !collectionStatusInput) return;
    setCollectionStatusLoading(true);
    setCollectionStatusError(null);
    try {
      setCollectionStatus(await getAdminCollectionIndexStatus(collectionStatusInput.trim(), accessToken));
    } catch (err) {
      setCollectionStatusError(err instanceof Error ? err.message : 'Failed to fetch collection status');
    } finally {
      setCollectionStatusLoading(false);
    }
  };

  const loadProjectStatus = async () => {
    if (!accessToken || !projectStatusInput) return;
    setProjectStatusLoading(true);
    setProjectStatusError(null);
    try {
      setProjectStatus(await getAdminProjectIndexStatus(projectStatusInput.trim(), accessToken));
    } catch (err) {
      setProjectStatusError(err instanceof Error ? err.message : 'Failed to fetch project status');
    } finally {
      setProjectStatusLoading(false);
    }
  };

  const refreshWallet = async () => {
    if (!accessToken || !walletStatusInput) return;
    await refreshAdminWalletIndexing(walletStatusInput.trim(), accessToken);
    await loadWalletStatus();
    await loadJobs();
  };

  const refreshCollection = async () => {
    if (!accessToken || !collectionStatusInput) return;
    await refreshAdminCollectionIndexing(collectionStatusInput.trim(), accessToken);
    await loadCollectionStatus();
    await loadJobs();
  };

  const refreshProject = async () => {
    if (!accessToken || !projectStatusInput) return;
    await refreshAdminProjectIndexing(projectStatusInput.trim(), accessToken);
    await loadProjectStatus();
    await loadJobs();
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <div className="mb-6 grid gap-3 md:grid-cols-3">
        <StatusPanel
          title="Wallet Index Status"
          placeholder="Wallet ID"
          value={walletStatusInput}
          onChange={setWalletStatusInput}
          onLookup={loadWalletStatus}
          onRefresh={refreshWallet}
          status={walletStatus}
          loading={walletStatusLoading}
          error={walletStatusError}
        />
        <StatusPanel
          title="Collection Index Status"
          placeholder="Collection ID or Contract"
          value={collectionStatusInput}
          onChange={setCollectionStatusInput}
          onLookup={loadCollectionStatus}
          onRefresh={refreshCollection}
          status={collectionStatus}
          loading={collectionStatusLoading}
          error={collectionStatusError}
        />
        <StatusPanel
          title="Project Index Status"
          placeholder="Project ID or Slug"
          value={projectStatusInput}
          onChange={setProjectStatusInput}
          onLookup={loadProjectStatus}
          onRefresh={refreshProject}
          status={projectStatus}
          loading={projectStatusLoading}
          error={projectStatusError}
        />
      </div>

      <div className="mb-6 flex items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-gray-500">Status</label>
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value as '' | IndexingJobStatus);
            }}
            className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
          >
            {statusOptions.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">Wallet ID</label>
          <input
            value={walletId}
            onChange={(e) => {
              setPage(1);
              setWalletId(e.target.value.trim());
            }}
            placeholder="Optional wallet UUID"
            className="w-80 rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
          <span className="text-gray-400">Loading indexing jobs...</span>
        </div>
      ) : error ? (
        <div className="rounded border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">
          <p>{error}</p>
          <button onClick={loadJobs} className="mt-2 text-xs text-red-200 underline">Retry</button>
        </div>
      ) : jobs.length === 0 ? (
        <p className="text-gray-500">No indexing jobs found for current filters.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500">
                  <th className="pb-3 pr-4 font-medium">Status</th>
                  <th className="pb-3 pr-4 font-medium">Started</th>
                  <th className="pb-3 pr-4 font-medium">Finished</th>
                  <th className="pb-3 pr-4 font-medium">Duration</th>
                  <th className="pb-3 pr-4 font-medium">Wallet/User</th>
                  <th className="pb-3 pr-4 font-medium">Processed</th>
                  <th className="pb-3 pr-4 font-medium">Error</th>
                  <th className="pb-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td className="py-3 pr-4">
                      <span className={`rounded px-2 py-1 text-xs ${statusClass(job.status)}`}>
                        {job.status === 'completed' ? 'done' : job.status}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-gray-400">{new Date(job.startedAt).toLocaleString()}</td>
                    <td className="py-3 pr-4 text-gray-400">{job.finishedAt ? new Date(job.finishedAt).toLocaleString() : '-'}</td>
                    <td className="py-3 pr-4 text-gray-400">{formatDuration(job.durationMs)}</td>
                    <td className="py-3 pr-4 text-xs text-gray-400"><div>{job.walletId}</div><div>{job.userId}</div></td>
                    <td className="py-3 pr-4 text-xs text-gray-300">{statsSummary(job.statsJson)}</td>
                    <td className="max-w-xs truncate py-3 pr-4 text-xs text-red-300">{job.error ?? '-'}</td>
                    <td className="py-3">
                      <div className="flex gap-2 text-xs">
                        <button onClick={() => openDetails(job.id)} className="text-purple-400 hover:text-purple-300">View</button>
                        {(job.status === 'failed' || job.status === 'completed') && (
                          <button onClick={() => retryJob(job)} className="text-amber-300 hover:text-amber-200">Retry</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between text-sm text-gray-400">
            <span>Page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded border border-gray-700 px-2 py-1 disabled:opacity-40">Prev</button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="rounded border border-gray-700 px-2 py-1 disabled:opacity-40">Next</button>
            </div>
          </div>
        </>
      )}

      {detailsOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 p-4" onClick={() => setDetailsOpen(false)}>
          <div className="mx-auto mt-10 max-w-2xl rounded-xl border border-gray-800 bg-gray-950 p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Indexing Job Details</h3>
              <button onClick={() => setDetailsOpen(false)} className="text-sm text-gray-400">Close</button>
            </div>
            {detailsLoading ? (
              <p className="text-gray-400">Loading details...</p>
            ) : selected ? (
              <pre className="max-h-[60vh] overflow-auto rounded bg-black p-3 text-xs text-gray-200">{JSON.stringify(selected, null, 2)}</pre>
            ) : (
              <p className="text-gray-500">No details available.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
