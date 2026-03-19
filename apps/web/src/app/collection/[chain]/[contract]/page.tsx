'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCollectionByChainAndContract, type CollectionDetails, type CollectionVerificationStatus } from '@/lib/api';
import { chainCurrency, formatPrice, truncateAddress } from '@/lib/utils';

interface CollectionPageProps {
  params: { chain: string; contract: string };
}

const STATUS_STYLES: Record<CollectionVerificationStatus, string> = {
  tracked_unverified: 'bg-yellow-900/30 text-yellow-300 border border-yellow-600/50',
  pending_claim: 'bg-blue-900/30 text-blue-300 border border-blue-600/50',
  verified: 'bg-green-900/30 text-green-300 border border-green-600/50',
  rejected: 'bg-red-900/30 text-red-300 border border-red-600/50',
};

function trustCopy(status: CollectionVerificationStatus) {
  if (status === 'tracked_unverified' || status === 'rejected') {
    return 'Tracked, not yet verified. Data may be incomplete or unaffiliated.';
  }
  return null;
}

export default function CollectionPage({ params }: CollectionPageProps) {
  const [collection, setCollection] = useState<CollectionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCollection = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getCollectionByChainAndContract(params.chain, params.contract);
      setCollection(data);
    } catch (err) {
      setCollection(null);
      setError(err instanceof Error ? err.message : 'Failed to load collection');
    } finally {
      setLoading(false);
    }
  }, [params.chain, params.contract]);

  useEffect(() => {
    loadCollection();
  }, [loadCollection]);

  const pageTitle = useMemo(() => {
    if (collection) return collection.name;
    return truncateAddress(params.contract, 6);
  }, [collection, params.contract]);

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
            <span className={`rounded px-2 py-1 text-xs font-medium uppercase tracking-wide ${STATUS_STYLES[collection.verificationStatus]}`}>
              {collection.verificationStatus.replace('_', ' ')}
            </span>
            <span className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300">
              Mapping: {collection.mappingStatus}
            </span>
          </div>

          <p className="text-sm text-gray-400">
            {collection.chain} · {truncateAddress(collection.contractAddress, 6)}
          </p>

          {(() => {
            const copy = trustCopy(collection.verificationStatus);
            if (!copy) return null;
            return (
              <p className="mt-4 rounded-lg border border-yellow-700/50 bg-yellow-900/20 px-4 py-3 text-sm text-yellow-200">
                {copy}
              </p>
            );
          })()}

          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <p className="text-xs uppercase tracking-wide text-gray-500">Floor price</p>
              <p className="mt-1 text-sm font-medium">
                {collection.metrics.floorPrice === null
                  ? 'N/A'
                  : formatPrice(collection.metrics.floorPrice, chainCurrency(collection.chain))}
              </p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <p className="text-xs uppercase tracking-wide text-gray-500">Holders</p>
              <p className="mt-1 text-sm font-medium">
                {collection.metrics.holderCount === null
                  ? 'N/A'
                  : collection.metrics.holderCount.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <p className="text-xs uppercase tracking-wide text-gray-500">Listed</p>
              <p className="mt-1 text-sm font-medium">
                {collection.metrics.listedCount === null
                  ? 'N/A'
                  : collection.metrics.listedCount.toLocaleString()}
              </p>
            </div>
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
    </main>
  );
}
