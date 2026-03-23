'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getRelatedCollections, type RelatedCollection } from '@/lib/api';

interface RelatedCollectionsProps {
  collectionId: string;
}

export function RelatedCollections({ collectionId }: RelatedCollectionsProps) {
  const [related, setRelated] = useState<RelatedCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const fetchRelated = async () => {
      try {
        setLoading(true);
        const data = await getRelatedCollections(collectionId, 6);
        if (mounted) {
          setRelated(data);
        }
      } catch (err: any) {
        if (mounted) {
          console.error('Failed to load related collections:', err);
          setError(err.message || 'Failed to load related collections');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    fetchRelated();

    return () => {
      mounted = false;
    };
  }, [collectionId]);

  if (loading) {
    return (
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h2 className="text-xl font-semibold">Related Collections</h2>
        <div className="mt-4 flex items-center justify-center py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-700 border-t-purple-500"></div>
        </div>
      </section>
    );
  }

  if (error || related.length === 0) {
    return null; // Don't show section if no data or error
  }

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Related Collections</h2>
        <span className="text-xs text-gray-500">Based on on-chain holder data</span>
      </div>
      <p className="mt-1 text-sm text-gray-400">
        Collections with overlapping holders ({related[0]?.sharedHolders || 0}+ shared addresses)
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {related.map((collection) => (
          <Link
            key={collection.id}
            href={`/collection/${collection.chain}/${collection.contractAddress}`}
            className="group rounded-lg border border-gray-800 bg-gray-950 p-4 transition-all hover:border-purple-600 hover:bg-gray-900"
          >
            <div className="flex items-start gap-3">
              {collection.imageUrl ? (
                <img
                  src={collection.imageUrl}
                  alt={collection.name}
                  className="h-12 w-12 rounded-lg object-cover"
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gray-800 text-gray-600">
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
              )}

              <div className="min-w-0 flex-1">
                <h3 className="truncate font-medium text-gray-100 group-hover:text-purple-400">
                  {collection.name}
                </h3>
                <p className="mt-1 text-xs text-gray-500">
                  {collection.chain.toUpperCase()}
                </p>
                <div className="mt-2 flex items-center gap-3 text-xs">
                  <span className="text-gray-400">
                    <span className="font-medium text-purple-400">{collection.overlapPercentage}%</span> overlap
                  </span>
                  <span className="text-gray-600">•</span>
                  <span className="text-gray-400">
                    {collection.sharedHolders} shared
                  </span>
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {related.length >= 6 && (
        <p className="mt-4 text-center text-xs text-gray-500">
          Showing top {related.length} related collections
        </p>
      )}
    </section>
  );
}
