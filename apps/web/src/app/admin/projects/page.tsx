'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { ConfirmModal } from '@/components/ui/confirm-modal';

interface Project {
  id: string;
  name: string;
  slug: string;
  isVerified: boolean;
  isFeatured: boolean;
  healthScore: number | null;
  createdAt: string;
  collections: { id: string; name: string; contractAddress: string; chain: string; isSpam: boolean | null }[];
}

type Filter = 'all' | 'auto' | 'spam' | 'empty';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'auto', label: 'Auto-created' },
  { value: 'spam', label: 'Has spam collection' },
  { value: 'empty', label: 'No collections' },
];

/** The API takes at most this many projects per bulk delete. */
const MAX_BULK_DELETE = 500;

interface Selected {
  name: string;
  collections: number;
  isVerified: boolean;
}

interface BulkDeleteResult {
  deleted: { id: string; name: string }[];
  unlinkedCollections: number;
  flaggedSpam: number;
  skipped: { id: string; name: string; reason: string }[];
  notFound: string[];
}

interface ProjectList {
  items: Project[];
  total: number;
  page: number;
  limit: number;
}

interface ProjectOwner {
  id: string;
  userId: string;
  role: 'owner' | 'editor';
  assignedAt: string;
  user?: { id: string; role: string };
}

export default function AdminProjectsPage() {
  const { accessToken } = useAuth();
  const router = useRouter();
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [data, setData] = useState<ProjectList | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [owners, setOwners] = useState<ProjectOwner[]>([]);
  const [newOwnerUserId, setNewOwnerUserId] = useState('');
  const [newOwnerRole, setNewOwnerRole] = useState<'owner' | 'editor'>('editor');
  const [featurePending, setFeaturePending] = useState<Record<string, boolean>>({});
  const [featureError, setFeatureError] = useState<Record<string, string | null>>({});
  const [copiedProjectId, setCopiedProjectId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [pageSize, setPageSize] = useState(20);
  const [selected, setSelected] = useState<Map<string, Selected>>(new Map());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [markSpam, setMarkSpam] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deletingOne, setDeletingOne] = useState(false);
  const [removeOwnerTarget, setRemoveOwnerTarget] = useState<{ projectId: string; userId: string } | null>(null);

  const requestSeq = useRef(0);

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = search.trim();
      if (next === query) return;
      setQuery(next);
      setPage(1);
      // A selection belongs to the list it was made in.
      setSelected(new Map());
    }, 300);
    return () => clearTimeout(t);
  }, [search, query]);

  const fetchProjects = () => {
    if (!accessToken) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(pageSize), filter });
    if (query) params.set('q', query);
    apiFetch<ProjectList>(`/admin/projects?${params}`, { token: accessToken })
      .then((result) => {
        // Ignore a response that a newer request has overtaken.
        if (seq !== requestSeq.current) return;
        // Deleting can leave us past the last page; go to the new last page.
        const lastPage = Math.max(1, Math.ceil(result.total / result.limit));
        if (result.items.length === 0 && page > lastPage) {
          setPage(lastPage);
          return;
        }
        setData(result);
      })
      .catch(() => null)
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  };

  useEffect(fetchProjects, [accessToken, page, pageSize, filter, query]);

  const pageItems = data?.items ?? [];
  const allOnPageSelected = pageItems.length > 0 && pageItems.every((p) => selected.has(p.id));
  const selectedList = [...selected.entries()];
  const selectedCollections = selectedList.reduce((sum, [, s]) => sum + s.collections, 0);
  const selectedVerified = selectedList.filter(([, s]) => s.isVerified).length;

  const toggleSelected = (p: Project) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(p.id)) next.delete(p.id);
      else next.set(p.id, { name: p.name, collections: p.collections.length, isVerified: p.isVerified });
      return next;
    });
  };

  const toggleSelectPage = () => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (allOnPageSelected) pageItems.forEach((p) => next.delete(p.id));
      else
        pageItems.forEach((p) =>
          next.set(p.id, { name: p.name, collections: p.collections.length, isVerified: p.isVerified }),
        );
      return next;
    });
  };

  const bulkDelete = async () => {
    if (!accessToken || selected.size === 0) return;
    setBulkDeleting(true);
    try {
      const result = await apiFetch<BulkDeleteResult>(`/admin/projects/bulk-delete`, {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({ projectIds: [...selected.keys()], markCollectionsSpam: markSpam }),
      });
      const parts = [
        `Deleted ${result.deleted.length} project${result.deleted.length === 1 ? '' : 's'}`,
        `unlinked ${result.unlinkedCollections} collection${result.unlinkedCollections === 1 ? '' : 's'}`,
      ];
      if (result.flaggedSpam) parts.push(`flagged ${result.flaggedSpam} as spam`);
      toast.success(parts.join(', '));
      for (const s of result.skipped) toast.warning(`Kept ${s.name}: ${s.reason}`);
      if (result.notFound.length) {
        toast.info(`${result.notFound.length} had already been deleted`);
      }
      setSelected(new Map());
      setConfirmOpen(false);
      setMarkSpam(false);
      fetchProjects();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the projects');
    } finally {
      setBulkDeleting(false);
    }
  };

  const createProject = async () => {
    if (!accessToken || !newName.trim()) return;
    setCreating(true);
    try {
      const created = await apiFetch<{ id: string }>(`/admin/projects`, {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({ name: newName.trim() }),
      });
      router.push(`/admin/projects/${created.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the project');
      setCreating(false);
    }
  };

  const toggleVerify = async (project: Project) => {
    if (!accessToken) return;
    await apiFetch(`/admin/projects/${project.id}/verify`, {
      method: 'PATCH',
      token: accessToken,
      body: JSON.stringify({ isVerified: !project.isVerified }),
    });
    fetchProjects();
  };

  const toggleFeatured = async (project: Project) => {
    if (!accessToken || featurePending[project.id]) return;

    setFeatureError((prev) => ({ ...prev, [project.id]: null }));
    setFeaturePending((prev) => ({ ...prev, [project.id]: true }));

    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((item) =>
          item.id === project.id ? { ...item, isFeatured: !project.isFeatured } : item,
        ),
      };
    });

    try {
      await apiFetch(`/admin/projects/${project.id}/featured`, {
        method: 'PATCH',
        token: accessToken,
        body: JSON.stringify({ isFeatured: !project.isFeatured }),
      });
    } catch (error) {
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((item) =>
            item.id === project.id ? { ...item, isFeatured: project.isFeatured } : item,
          ),
        };
      });

      const message = error instanceof Error ? error.message : 'Failed to update featured status';
      setFeatureError((prev) => ({ ...prev, [project.id]: message }));
    } finally {
      setFeaturePending((prev) => ({ ...prev, [project.id]: false }));
    }
  };

  const deleteProject = async (project: Project) => {
    if (!accessToken) return;
    setDeletingOne(true);
    try {
      await apiFetch(`/admin/projects/${project.id}`, {
        method: 'DELETE',
        token: accessToken,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the project');
      return;
    } finally {
      setDeletingOne(false);
    }
    setDeleteTarget(null);
    setSelected((prev) => {
      if (!prev.has(project.id)) return prev;
      const next = new Map(prev);
      next.delete(project.id);
      return next;
    });
    fetchProjects();
  };

  const copyProjectId = async (projectId: string) => {
    try {
      await navigator.clipboard.writeText(projectId);
      setCopiedProjectId(projectId);
      setTimeout(() => {
        setCopiedProjectId((current) => (current === projectId ? null : current));
      }, 1500);
    } catch {
      setFeatureError((prev) => ({ ...prev, [projectId]: 'Failed to copy UUID' }));
    }
  };

  const toggleOwners = async (projectId: string) => {
    if (expandedId === projectId) {
      setExpandedId(null);
      return;
    }
    if (!accessToken) return;
    setExpandedId(projectId);
    const data = await apiFetch<ProjectOwner[]>(`/admin/projects/${projectId}/owners`, {
      token: accessToken,
    }).catch(() => []);
    setOwners(data);
  };

  const addOwner = async (projectId: string) => {
    if (!accessToken || !newOwnerUserId.trim()) return;
    await apiFetch(`/admin/projects/${projectId}/owners`, {
      method: 'POST',
      token: accessToken,
      body: JSON.stringify({ userId: newOwnerUserId.trim(), role: newOwnerRole }),
    });
    setNewOwnerUserId('');
    toggleOwners(projectId);
    // Re-expand to refresh
    setExpandedId(null);
    setTimeout(() => toggleOwners(projectId), 100);
  };

  const removeOwner = async (projectId: string, userId: string) => {
    if (!accessToken) return;
    setRemoveOwnerTarget(null);
    await apiFetch(`/admin/projects/${projectId}/owners/${userId}`, {
      method: 'DELETE',
      token: accessToken,
    });
    setExpandedId(null);
    setTimeout(() => toggleOwners(projectId), 100);
  };

  if (loading && !data) {
    return (
      <div className="flex items-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
        <span className="text-gray-400">Loading projects...</span>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Projects ({data?.total ?? 0})</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createProject();
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            placeholder="New project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-48 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500"
          />
          <button
            type="submit"
            disabled={!newName.trim() || creating}
            className="rounded bg-purple-600 px-3 py-1 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'New project'}
          </button>
        </form>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => {
              if (f.value === filter) return;
              setFilter(f.value);
              setPage(1);
              setSelected(new Map());
            }}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === f.value ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
        <input
          type="search"
          placeholder="Search name or slug"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto w-56 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500"
        />
        <select
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(1);
          }}
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-white"
          aria-label="Projects per page"
        >
          {[20, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n} per page
            </option>
          ))}
        </select>
      </div>

      <div className="mb-2 flex items-center gap-3 px-4 text-xs text-gray-400">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={allOnPageSelected}
            onChange={toggleSelectPage}
            disabled={pageItems.length === 0}
            className="accent-purple-500"
          />
          Select this page
        </label>
        {selected.size > 0 && (
          <>
            <span className="text-gray-300">{selected.size} selected</span>
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={selected.size > MAX_BULK_DELETE}
              className="rounded bg-red-600 px-3 py-1 font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              Delete selected
            </button>
            <button onClick={() => setSelected(new Map())} className="text-purple-400 hover:text-purple-300">
              Clear
            </button>
            {selected.size > MAX_BULK_DELETE && (
              <span className="text-red-400">Select at most {MAX_BULK_DELETE} at a time.</span>
            )}
          </>
        )}
      </div>

      {data && pageItems.length === 0 && (
        <p className="px-4 py-6 text-sm text-gray-500">No projects match.</p>
      )}

      <div className="space-y-2">
        {pageItems.map((p) => (
          <div
            key={p.id}
            className={`rounded-xl border ${selected.has(p.id) ? 'border-red-800 bg-red-950/10' : 'border-gray-800'}`}
          >
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-4">
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggleSelected(p)}
                  aria-label={`Select ${p.name}`}
                  className="accent-purple-500"
                />
                <div>
                  <Link href={`/admin/projects/${p.id}`} className="font-medium hover:text-purple-300">
                    {p.name}
                  </Link>
                  <span className="ml-2 text-xs text-gray-500">/{p.slug}</span>
                  <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                    <span className="font-mono">{p.id.slice(0, 8)}...</span>
                    <button
                      onClick={() => copyProjectId(p.id)}
                      className="text-purple-400 hover:text-purple-300"
                    >
                      {copiedProjectId === p.id ? 'Copied' : 'Copy UUID'}
                    </button>
                  </div>
                </div>
                <span className="text-xs text-gray-500">
                  {p.collections.length} collection{p.collections.length !== 1 ? 's' : ''}
                </span>
                {p.collections.some((c) => c.isSpam) && (
                  <span className="rounded bg-red-900/30 px-1.5 py-0.5 text-xs text-red-400">
                    {p.collections.filter((c) => c.isSpam).length} spam
                  </span>
                )}
                {p.healthScore !== null && (
                  <span className={`text-xs ${
                    p.healthScore >= 70 ? 'text-green-400' :
                    p.healthScore >= 40 ? 'text-yellow-400' : 'text-red-400'
                  }`}>
                    Score: {p.healthScore}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => toggleVerify(p)}
                  className={`rounded px-2 py-0.5 text-xs font-medium ${
                    p.isVerified
                      ? 'bg-green-900/30 text-green-400'
                      : 'bg-gray-800 text-gray-500'
                  }`}
                >
                  {p.isVerified ? 'Verified' : 'Unverified'}
                </button>
                <button
                  onClick={() => toggleFeatured(p)}
                  disabled={Boolean(featurePending[p.id])}
                  className={`rounded px-2 py-0.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
                    p.isFeatured
                      ? 'bg-amber-900/40 text-amber-300'
                      : 'bg-gray-800 text-gray-500'
                  }`}
                >
                  {featurePending[p.id]
                    ? 'Updating...'
                    : p.isFeatured
                      ? 'Featured'
                      : 'Not Featured'}
                </button>
                <Link href={`/admin/projects/${p.id}`} className="text-xs text-purple-400 hover:text-purple-300">
                  Edit
                </Link>
                <button
                  onClick={() => toggleOwners(p.id)}
                  className="text-xs text-purple-400 hover:text-purple-300"
                >
                  {expandedId === p.id ? 'Hide' : 'Owners'}
                </button>
                <button
                  onClick={() => setDeleteTarget(p)}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Delete
                </button>
              </div>
            </div>

            {featureError[p.id] && (
              <div className="px-4 pb-2 text-xs text-red-400">{featureError[p.id]}</div>
            )}

            {/* Owners panel */}
            {expandedId === p.id && (
              <div className="border-t border-gray-800 px-4 py-3">
                <h4 className="mb-2 text-sm font-medium text-gray-300">Project Owners</h4>
                {owners.length === 0 ? (
                  <p className="text-xs text-gray-500">No owners assigned.</p>
                ) : (
                  <div className="mb-3 space-y-1">
                    {owners.map((o) => (
                      <div key={o.id} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-gray-400">
                            {o.userId.slice(0, 8)}...
                          </span>
                          <span className={`rounded px-1.5 py-0.5 text-xs ${
                            o.role === 'owner'
                              ? 'bg-purple-900/30 text-purple-400'
                              : 'bg-gray-800 text-gray-400'
                          }`}>
                            {o.role}
                          </span>
                        </div>
                        <button
                          onClick={() => setRemoveOwnerTarget({ projectId: p.id, userId: o.userId })}
                          className="text-xs text-red-400 hover:text-red-300"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="User ID"
                    value={newOwnerUserId}
                    onChange={(e) => setNewOwnerUserId(e.target.value)}
                    className="flex-1 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-white placeholder-gray-500 outline-none focus:border-purple-500"
                  />
                  <select
                    value={newOwnerRole}
                    onChange={(e) => setNewOwnerRole(e.target.value as 'owner' | 'editor')}
                    className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-white"
                  >
                    <option value="editor">Editor</option>
                    <option value="owner">Owner</option>
                  </select>
                  <button
                    onClick={() => addOwner(p.id)}
                    disabled={!newOwnerUserId.trim()}
                    className="rounded bg-purple-600 px-3 py-1 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => !bulkDeleting && setConfirmOpen(false)}
        onConfirm={bulkDelete}
        title={`Delete ${selected.size} project${selected.size === 1 ? '' : 's'}?`}
        message={
          <>
            <span className="block text-sm">
              This cannot be undone. Their owners, wiki pages, events and holder-analysis data are deleted with
              them. Their {selectedCollections} collection{selectedCollections === 1 ? '' : 's'} stay tracked,
              without a project.
            </span>
            {selectedVerified > 0 && (
              <span className="mt-2 block text-sm text-amber-400">
                {selectedVerified} of these {selectedVerified === 1 ? 'is' : 'are'} verified.
              </span>
            )}
            <span className="mt-3 block max-h-40 overflow-y-auto rounded border border-gray-800 p-2 text-xs text-gray-400">
              {selectedList.slice(0, 50).map(([id, s]) => (
                <span key={id} className="block truncate">
                  {s.name}
                </span>
              ))}
              {selectedList.length > 50 && <span className="block">and {selectedList.length - 50} more</span>}
            </span>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={markSpam}
                onChange={(e) => setMarkSpam(e.target.checked)}
                className="accent-red-500"
              />
              Also flag their collections as spam
            </label>
          </>
        }
        confirmText={`Delete ${selected.size}`}
        variant="danger"
        loading={bulkDeleting}
      />
      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => !deletingOne && setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteProject(deleteTarget)}
        title={`Delete ${deleteTarget?.name ?? 'this project'}?`}
        message={
          deleteTarget?.collections.length
            ? 'This cannot be undone. Its collections stay tracked, without a project.'
            : 'This cannot be undone.'
        }
        confirmText="Delete"
        variant="danger"
        loading={deletingOne}
      />
      <ConfirmModal
        isOpen={!!removeOwnerTarget}
        onClose={() => setRemoveOwnerTarget(null)}
        onConfirm={() => removeOwnerTarget && removeOwner(removeOwnerTarget.projectId, removeOwnerTarget.userId)}
        title="Remove this owner?"
        message="They will no longer be able to manage this project."
        confirmText="Remove"
        variant="danger"
      />

      {/* Pagination */}
      {data && data.total > data.limit && (
        <div className="mt-6 flex items-center gap-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="rounded border border-gray-700 px-3 py-1 text-sm disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-gray-400">
            Page {page} of {Math.ceil(data.total / data.limit)}
          </span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= Math.ceil(data.total / data.limit)}
            className="rounded border border-gray-700 px-3 py-1 text-sm disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
