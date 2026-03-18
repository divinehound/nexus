'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';

interface WikiSuggestion {
  id: string;
  projectId: string;
  submittedBy: string;
  field: string;
  proposedValue: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export default function AdminWikiPage() {
  const { accessToken } = useAuth();
  const [suggestions, setSuggestions] = useState<WikiSuggestion[]>([]);
  const [filter, setFilter] = useState<string>('pending');
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchSuggestions = () => {
    if (!accessToken) return;
    setLoading(true);
    apiFetch<WikiSuggestion[]>(`/admin/wiki/suggestions?status=${filter}`, { token: accessToken })
      .then(setSuggestions)
      .catch(() => [])
      .finally(() => setLoading(false));
  };

  useEffect(fetchSuggestions, [accessToken, filter]);

  const handleApprove = async (id: string) => {
    if (!accessToken) return;
    await apiFetch(`/admin/wiki/suggestions/${id}/approve`, {
      method: 'PATCH',
      token: accessToken,
    });
    fetchSuggestions();
  };

  const handleReject = async (id: string) => {
    if (!accessToken) return;
    await apiFetch(`/admin/wiki/suggestions/${id}/reject`, {
      method: 'PATCH',
      token: accessToken,
    });
    fetchSuggestions();
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Wiki Suggestions</h2>
        <div className="flex gap-1">
          {['pending', 'approved', 'rejected'].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`rounded-lg px-3 py-1 text-sm capitalize ${
                filter === s ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
          <span className="text-gray-400">Loading...</span>
        </div>
      ) : suggestions.length === 0 ? (
        <p className="text-gray-500">No {filter} suggestions.</p>
      ) : (
        <div className="space-y-3">
          {suggestions.map((s) => (
            <div key={s.id} className="rounded-xl border border-gray-800 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium">Field: {s.field}</span>
                  <span className="ml-3 text-xs text-gray-500">
                    Project: {s.projectId.slice(0, 8)}...
                  </span>
                  <span className="ml-3 text-xs text-gray-500">
                    By: {s.submittedBy.slice(0, 8)}...
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">
                    {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${
                    s.status === 'pending' ? 'bg-yellow-900/30 text-yellow-400' :
                    s.status === 'approved' ? 'bg-green-900/30 text-green-400' :
                    'bg-red-900/30 text-red-400'
                  }`}>
                    {s.status}
                  </span>
                </div>
              </div>

              <button
                onClick={() => setExpandedId(expandedId === s.id ? null : s.id)}
                className="mt-2 text-xs text-purple-400 hover:text-purple-300"
              >
                {expandedId === s.id ? 'Hide' : 'Show'} proposed content
              </button>

              {expandedId === s.id && (
                <div className="mt-3 rounded-lg bg-gray-900 p-3 text-sm text-gray-300 whitespace-pre-wrap">
                  {s.proposedValue}
                </div>
              )}

              {s.status === 'pending' && (
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => handleApprove(s.id)}
                    className="rounded-lg bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-500"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleReject(s.id)}
                    className="rounded-lg bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-500"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
