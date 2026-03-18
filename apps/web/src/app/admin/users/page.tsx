'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';

interface UserItem {
  id: string;
  role: string;
  echoScore: number | null;
  createdAt: string;
  lastActiveAt: string | null;
}

interface UserList {
  items: UserItem[];
  total: number;
  page: number;
  limit: number;
}

export default function AdminUsersPage() {
  const { user: currentUser, accessToken } = useAuth();
  const [data, setData] = useState<UserList | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const fetchUsers = () => {
    if (!accessToken) return;
    setLoading(true);
    apiFetch<UserList>(`/admin/users?page=${page}&limit=20`, { token: accessToken })
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false));
  };

  useEffect(fetchUsers, [accessToken, page]);

  const toggleRole = async (user: UserItem) => {
    if (!accessToken) return;
    if (user.id === currentUser?.id) {
      alert('You cannot change your own role.');
      return;
    }
    const newRole = user.role === 'admin' ? 'user' : 'admin';
    if (!confirm(`Set ${user.id.slice(0, 8)}... to "${newRole}"?`)) return;
    await apiFetch(`/admin/users/${user.id}/role`, {
      method: 'PATCH',
      token: accessToken,
      body: JSON.stringify({ role: newRole }),
    });
    fetchUsers();
  };

  if (loading && !data) {
    return (
      <div className="flex items-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
        <span className="text-gray-400">Loading users...</span>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Users ({data?.total ?? 0})</h2>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500">
              <th className="pb-3 pr-4 font-medium">ID</th>
              <th className="pb-3 pr-4 font-medium">Role</th>
              <th className="pb-3 pr-4 font-medium">Echo Score</th>
              <th className="pb-3 pr-4 font-medium">Created</th>
              <th className="pb-3 pr-4 font-medium">Last Active</th>
              <th className="pb-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {data?.items.map((u) => (
              <tr key={u.id}>
                <td className="py-3 pr-4 font-mono text-xs">
                  {u.id.slice(0, 8)}...
                  {u.id === currentUser?.id && (
                    <span className="ml-2 text-purple-400">(you)</span>
                  )}
                </td>
                <td className="py-3 pr-4">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                    u.role === 'admin' ? 'bg-purple-900/30 text-purple-400' : 'bg-gray-800 text-gray-400'
                  }`}>
                    {u.role}
                  </span>
                </td>
                <td className="py-3 pr-4 text-gray-400">
                  {u.echoScore ?? '—'}
                </td>
                <td className="py-3 pr-4 text-gray-400">
                  {new Date(u.createdAt).toLocaleDateString()}
                </td>
                <td className="py-3 pr-4 text-gray-400">
                  {u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleDateString() : '—'}
                </td>
                <td className="py-3">
                  <button
                    onClick={() => toggleRole(u)}
                    disabled={u.id === currentUser?.id}
                    className="text-xs text-purple-400 hover:text-purple-300 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {u.role === 'admin' ? 'Demote' : 'Promote'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
