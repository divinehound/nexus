'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';

interface Project {
  id: string;
  name: string;
  slug: string;
  isVerified: boolean;
  isFeatured: boolean;
  healthScore: number | null;
  createdAt: string;
  collections: { id: string; name: string; contractAddress: string; chain: string }[];
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
  const [data, setData] = useState<ProjectList | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [owners, setOwners] = useState<ProjectOwner[]>([]);
  const [newOwnerUserId, setNewOwnerUserId] = useState('');
  const [newOwnerRole, setNewOwnerRole] = useState<'owner' | 'editor'>('editor');

  const fetchProjects = () => {
    if (!accessToken) return;
    setLoading(true);
    apiFetch<ProjectList>(`/admin/projects?page=${page}&limit=20`, { token: accessToken })
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false));
  };

  useEffect(fetchProjects, [accessToken, page]);

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
    if (!accessToken) return;
    await apiFetch(`/admin/projects/${project.id}/featured`, {
      method: 'PATCH',
      token: accessToken,
      body: JSON.stringify({ isFeatured: !project.isFeatured }),
    });
    fetchProjects();
  };

  const deleteProject = async (project: Project) => {
    if (!accessToken || !confirm(`Delete "${project.name}"? This cannot be undone.`)) return;
    await apiFetch(`/admin/projects/${project.id}`, {
      method: 'DELETE',
      token: accessToken,
    });
    fetchProjects();
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
    if (!accessToken || !confirm('Remove this owner?')) return;
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
      </div>

      <div className="space-y-2">
        {data?.items.map((p) => (
          <div key={p.id} className="rounded-xl border border-gray-800">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-4">
                <div>
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-2 text-xs text-gray-500">/{p.slug}</span>
                </div>
                <span className="text-xs text-gray-500">
                  {p.collections.length} collection{p.collections.length !== 1 ? 's' : ''}
                </span>
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
                  className={`rounded px-2 py-0.5 text-xs font-medium ${
                    p.isFeatured
                      ? 'bg-amber-900/40 text-amber-300'
                      : 'bg-gray-800 text-gray-500'
                  }`}
                >
                  {p.isFeatured ? 'Featured' : 'Not Featured'}
                </button>
                <button
                  onClick={() => toggleOwners(p.id)}
                  className="text-xs text-purple-400 hover:text-purple-300"
                >
                  {expandedId === p.id ? 'Hide' : 'Owners'}
                </button>
                <button
                  onClick={() => deleteProject(p)}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Delete
                </button>
              </div>
            </div>

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
                          onClick={() => removeOwner(p.id, o.userId)}
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
