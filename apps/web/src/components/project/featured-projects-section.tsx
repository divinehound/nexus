'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

interface FeaturedProject {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  healthScore: number | null;
}

export function FeaturedProjectsSection() {
  const [items, setItems] = useState<FeaturedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<FeaturedProject[]>('/projects/featured?limit=6');
      setItems(data);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : 'Failed to load featured projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="mt-12">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-200">Featured Projects</h2>
        <button onClick={load} className="text-xs text-gray-500 hover:text-white">Refresh</button>
      </div>

      {loading ? (
        <div className="flex items-center gap-3 rounded-xl border border-gray-800 p-4">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
          <span className="text-sm text-gray-400">Loading featured projects...</span>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-4">
          <p className="text-sm text-red-200">{error}</p>
          <button onClick={load} className="mt-3 rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600">
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-gray-800 p-4 text-sm text-gray-500">No featured projects yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p) => (
            <Link key={p.id} href={`/project/${p.slug}`} className="flex items-center gap-3 rounded-xl border border-gray-800 px-4 py-3 hover:border-gray-600">
              {p.imageUrl && <img src={p.imageUrl} alt={p.name} className="h-10 w-10 rounded-lg object-cover" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.name}</p>
                {p.healthScore !== null && <p className="text-xs text-gray-500">Score: {p.healthScore}</p>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
