'use client';

import { useEffect, useState } from 'react';
import { getRecommendations, type Recommendation } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import Link from 'next/link';

interface RecommendationsProps {
  limit?: number;
  minOverlap?: number;
}

export function PersonalizedRecommendations({ limit = 10, minOverlap = 3 }: RecommendationsProps) {
  const { user } = useAuth();
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<{ chain: string; address: string } | null>(
    null,
  );

  useEffect(() => {
    if (user?.primaryWallet) {
      setSelectedWallet({
        chain: user.primaryWallet.chain,
        address: user.primaryWallet.address,
      });
    } else if (user?.wallets && user.wallets.length > 0) {
      // Fallback to first wallet if no primary wallet set
      setSelectedWallet({
        chain: user.wallets[0].chain,
        address: user.wallets[0].address,
      });
    }
  }, [user]);

  useEffect(() => {
    if (selectedWallet) {
      loadRecommendations();
    } else if (user !== undefined && !user) {
      // User is logged out
      setLoading(false);
    }
  }, [selectedWallet, limit, minOverlap, user]);

  const loadRecommendations = async () => {
    if (!selectedWallet) return;

    setLoading(true);
    setError(null);
    try {
      const recs = await getRecommendations(selectedWallet.chain, selectedWallet.address, {
        limit,
        minOverlap,
      });
      setRecommendations(recs);
    } catch (err: any) {
      setError(err.message || 'Failed to load recommendations');
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 text-center">
        <h3 className="font-medium text-gray-100">Discover Collections</h3>
        <p className="mt-2 text-sm text-gray-400">
          Connect your wallet to get personalized collection recommendations
        </p>
      </div>
    );
  }

  if (!selectedWallet) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 text-center">
        <p className="text-sm text-gray-400">No wallet connected</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
          <span className="text-sm text-gray-400">Finding collections you might like...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-6">
        <p className="text-sm text-red-200">{error}</p>
        <button
          onClick={loadRecommendations}
          className="mt-3 rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with wallet selector - always visible */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-gray-100">You Might Like</h3>
          <p className="text-sm text-gray-400">
            Based on {selectedWallet.chain} wallet {selectedWallet.address.slice(0, 6)}...
            {selectedWallet.address.slice(-4)}
          </p>
        </div>
        {user.wallets && user.wallets.length > 1 && (
          <select
            value={`${selectedWallet.chain}:${selectedWallet.address}`}
            onChange={(e) => {
              const [chain, address] = e.target.value.split(':');
              setSelectedWallet({ chain, address });
            }}
            className="rounded border border-gray-700 bg-gray-900 px-3 py-1 text-sm text-gray-300"
          >
            {user.wallets.map((w) => (
              <option key={w.id} value={`${w.chain}:${w.address}`}>
                {w.chain}: {w.address.slice(0, 6)}...{w.address.slice(-4)}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Results or empty state */}
      {recommendations.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 text-center">
          <h3 className="font-medium text-gray-100">No Recommendations Yet</h3>
          <p className="mt-2 text-sm text-gray-400">
            We couldn't find collections with overlapping holders. This could mean:
          </p>
          <ul className="mt-3 space-y-1 text-left text-sm text-gray-500">
            <li>• Your collections haven't been indexed yet</li>
            <li>• You don't hold any indexed collections</li>
            <li>• Your collections are very unique (rare taste!)</li>
          </ul>
        </div>
      ) : (

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {recommendations.map((rec) => (
          <Link
            key={rec.collection.id}
            href={`/collection/${rec.collection.chain}/${rec.collection.contractAddress}`}
            className="group rounded-xl border border-gray-800 bg-gray-900/50 p-4 transition-colors hover:border-purple-700 hover:bg-gray-900"
          >
            <div className="flex items-start gap-3">
              {rec.collection.imageUrl ? (
                <img
                  src={rec.collection.imageUrl}
                  alt={rec.collection.name}
                  className="h-16 w-16 rounded-lg border border-gray-700 object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-gray-700 bg-gray-950 text-xs text-gray-500">
                  No Image
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h4 className="truncate font-medium text-gray-100 group-hover:text-purple-400">
                  {rec.collection.name}
                </h4>
                <p className="text-xs text-gray-500">{rec.collection.chain}</p>
                <div className="mt-1 flex items-center gap-2 text-xs text-gray-400">
                  <span>{rec.collection.holderCount.toLocaleString()} holders</span>
                  {rec.collection.floorPrice && (
                    <span>· Floor: {rec.collection.floorPrice} ETH</span>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-3 border-t border-gray-800 pt-3">
              <div className="mb-2 flex items-center gap-2">
                <div
                  className="h-2 flex-1 overflow-hidden rounded-full bg-gray-800"
                  title={`Match score: ${Math.round(rec.score * 100)}%`}
                >
                  <div
                    className="h-full bg-gradient-to-r from-purple-600 to-pink-600"
                    style={{ width: `${rec.score * 100}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-purple-400">
                  {Math.round(rec.score * 100)}%
                </span>
              </div>
              <p className="text-xs text-gray-500">{rec.reason}</p>
              {rec.basedOn.length > 0 && (
                <p className="mt-1 text-[10px] text-gray-600">
                  Based on: {rec.basedOn.map((b) => b.name).join(', ')}
                </p>
              )}
            </div>
          </Link>
        ))}
      </div>
      )}
    </div>
  );
}
