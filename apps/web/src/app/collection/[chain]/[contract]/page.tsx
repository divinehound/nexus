'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  getCollectionByChainAndContract,
  getCollectionStats,
  type CollectionDetails,
  type CollectionStatsResponse,
} from '@/lib/api';
import { chainCurrency, formatPrice, truncateAddress } from '@/lib/utils';
import { TrustBadge, TrustDisclaimer } from '@/components/trust/trust-badge';
import { CollectionTabs } from '@/components/collections/collection-tabs';

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return 'N/A';
  return value.toLocaleString();
}

export default function CollectionPage() {
  const routeParams = useParams<{ chain: string; contract: string }>();
  const chain = routeParams?.chain;
  const contract = routeParams?.contract;

  const [collection, setCollection] = useState<CollectionDetails | null>(null);
  const [stats, setStats] = useState<CollectionStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCollection = useCallback(async () => {
    if (!chain || !contract) {
      setError('Invalid collection route');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const collectionData = await getCollectionByChainAndContract(chain, contract);
      setCollection(collectionData);
      
      // Try to load stats, but don't fail if unavailable
      try {
        const statsData = await getCollectionStats(chain, contract);
        setStats(statsData);
      } catch (statsErr) {
        console.warn('Stats unavailable:', statsErr);
        setStats(null);
      }
    } catch (err) {
      setCollection(null);
      setStats(null);
      setError(err instanceof Error ? err.message : 'Failed to load collection');
    } finally {
      setLoading(false);
    }
  }, [chain, contract]);

  useEffect(() => {
    loadCollection();
  }, [loadCollection]);

  const pageTitle = useMemo(() => {
    if (collection) return collection.name;
    return contract ? truncateAddress(contract, 6) : 'Collection';
  }, [collection, contract]);

  const currency = collection ? chainCurrency(collection.chain) : 'ETH';
  const metrics = stats?.current;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-4">
        <Link href="/search" className="text-sm text-purple-400 hover:text-purple-300">
          ← Back to search
        </Link>
      </div>

      {loading && (
        <div className="rounded-xl border border-gray-800 p-6">
          <div className="flex items-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
            <span className="text-gray-400">Loading collection...</span>
          </div>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-6">
          <h1 className="text-xl font-semibold text-red-300">Failed to load collection</h1>
          <p className="mt-2 text-sm text-red-200/80">{error}</p>
          <button
            onClick={loadCollection}
            className="mt-4 rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && !collection && (
        <div className="rounded-xl border border-gray-800 p-6">
          <h1 className="text-xl font-semibold">Collection not found</h1>
          <p className="mt-2 text-sm text-gray-400">This contract has not been tracked yet.</p>
          <button
            onClick={loadCollection}
            className="mt-4 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:text-white"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && collection && (
        <section className="rounded-xl border border-gray-800 p-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{pageTitle}</h1>
            <TrustBadge status={collection.verificationStatus} />
            <span className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300">
              Mapping: {collection.mappingStatus}
            </span>
            {stats?.status === 'indexing' && (
              <span className="rounded border border-blue-800 bg-blue-950/60 px-2 py-1 text-xs text-blue-300">
                Indexing in progress
              </span>
            )}
            {stats?.status === 'stale' && (
              <span className="rounded border border-amber-800 bg-amber-950/60 px-2 py-1 text-xs text-amber-300">
                Stale
              </span>
            )}
          </div>

          <p className="text-sm text-gray-400">
            {collection.chain} · {truncateAddress(collection.contractAddress, 6)}
          </p>

          <TrustDisclaimer status={collection.verificationStatus} />

          <div className="mt-3 flex items-center gap-3">
            {stats?.lastUpdatedAt && (
              <p className="text-xs text-gray-500">
                Last updated {new Date(stats.lastUpdatedAt).toLocaleString()}
              </p>
            )}
            {(stats?.status === 'indexing' || stats?.status === 'stale') && (
              <button
                onClick={loadCollection}
                className="rounded-md border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:text-white"
              >
                Refresh stats
              </button>
            )}
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              label="Floor price"
              value={
                metrics?.floorPrice !== null && metrics?.floorPrice !== undefined
                  ? formatPrice(metrics.floorPrice, currency)
                  : collection.metrics.floorPrice !== null
                    ? formatPrice(collection.metrics.floorPrice, currency)
                    : 'N/A'
              }
              hint={stats?.deltas.floor24hPct !== undefined ? `${stats.deltas.floor24hPct}% vs 24h` : undefined}
            />
            <StatCard
              label="Holders"
              value={formatNumber(metrics?.holderCount ?? collection.metrics.holderCount)}
              hint={stats?.deltas.holders24hDelta !== undefined ? `${stats.deltas.holders24hDelta >= 0 ? '+' : ''}${stats.deltas.holders24hDelta} vs 24h` : undefined}
            />
            <StatCard
              label="Listed"
              value={formatNumber(metrics?.listedCount ?? collection.metrics.listedCount)}
            />
            <StatCard
              label="Volume 24h"
              value={metrics?.volume24h !== null && metrics?.volume24h !== undefined ? formatPrice(metrics.volume24h, currency) : 'N/A'}
              hint={stats?.deltas.volume24hPct !== undefined ? `${stats.deltas.volume24hPct}% vs 24h` : undefined}
            />
            <StatCard label="Sales 24h" value={formatNumber(metrics?.sales24h)} />
            <StatCard label="Unique buyers 24h" value={formatNumber(metrics?.uniqueBuyers24h)} />
          </div>

          <div className="mt-6 space-y-2 text-sm text-gray-400">
            {collection.project && (
              <p>
                Mapped project:{' '}
                <Link href={`/project/${collection.project.slug}`} className="text-purple-400 hover:text-purple-300">
                  {collection.project.name}
                </Link>
              </p>
            )}
            {!collection.project && <p>Mapped project: not set</p>}
            {collection.proposedProject && <p>Suggested project: {collection.proposedProject.name}</p>}
          </div>
        </section>
      )}

      {collection && <CollectionTabs collectionId={collection.id} chain={collection.chain} />}
    </main>
  );
}
