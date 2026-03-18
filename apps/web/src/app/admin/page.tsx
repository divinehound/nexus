'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';

interface Stats {
  projects: number;
  users: number;
  pendingWikiSuggestions: number;
  events: number;
}

export default function AdminDashboard() {
  const { accessToken } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accessToken) return;
    apiFetch<Stats>('/admin/stats', { token: accessToken })
      .then(setStats)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [accessToken]);

  if (loading) {
    return (
      <div className="flex items-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
        <span className="text-gray-400">Loading stats...</span>
      </div>
    );
  }

  if (!stats) {
    return <p className="text-gray-500">Failed to load stats.</p>;
  }

  const cards = [
    { label: 'Total Projects', value: stats.projects, color: 'text-blue-400' },
    { label: 'Total Users', value: stats.users, color: 'text-green-400' },
    { label: 'Pending Wiki Edits', value: stats.pendingWikiSuggestions, color: 'text-yellow-400' },
    { label: 'Total Events', value: stats.events, color: 'text-purple-400' },
  ];

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold">Dashboard</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border border-gray-800 p-6">
            <p className="text-sm text-gray-500">{card.label}</p>
            <p className={`mt-2 text-3xl font-bold ${card.color}`}>{card.value.toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
