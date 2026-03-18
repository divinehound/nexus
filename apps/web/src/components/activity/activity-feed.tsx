'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { truncateAddress } from '@/lib/utils';

interface ActivityItem {
  id: string;
  activityType: string;
  walletAddress: string | null;
  collectionId: string | null;
  tokenId: string | null;
  price: number | null;
  message: string | null;
  imageUrl: string | null;
  createdAt: string;
  reactions: { id: string; walletAddress: string }[];
}

export function ActivityFeed({ projectId }: { projectId: string }) {
  const { user, accessToken } = useAuth();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<ActivityItem[]>(`/projects/${projectId}/activity?limit=20`)
      .then(setItems)
      .catch(() => [])
      .finally(() => setLoading(false));
  }, [projectId]);

  const handleReact = async (activityId: string) => {
    if (!accessToken) return;
    try {
      await apiFetch(`/projects/${projectId}/activity/${activityId}/react`, {
        method: 'POST',
        token: accessToken,
      });
      setItems((prev) =>
        prev.map((item) =>
          item.id === activityId
            ? { ...item, reactions: [...item.reactions, { id: 'temp', walletAddress: user?.wallets[0]?.address || '' }] }
            : item,
        ),
      );
    } catch {
      // Reaction failed
    }
  };

  if (loading) {
    return <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />;
  }

  if (items.length === 0) {
    return <p className="text-sm text-gray-500">No activity yet.</p>;
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={item.id} className="rounded-xl border border-gray-800 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                item.activityType === 'sale' ? 'bg-green-900/30 text-green-400' :
                item.activityType === 'notable_sale' ? 'bg-yellow-900/30 text-yellow-400' :
                item.activityType === 'whale_move' ? 'bg-blue-900/30 text-blue-400' :
                item.activityType === 'flex' ? 'bg-purple-900/30 text-purple-400' :
                'bg-gray-800 text-gray-400'
              }`}>
                {item.activityType.replace('_', ' ')}
              </span>
              {item.walletAddress && (
                <span className="text-xs text-gray-500">{truncateAddress(item.walletAddress)}</span>
              )}
            </div>
            <span className="text-xs text-gray-500">
              {new Date(item.createdAt).toLocaleDateString()}
            </span>
          </div>

          {item.message && <p className="mt-2 text-sm text-gray-300">{item.message}</p>}

          {item.imageUrl && (
            <img src={item.imageUrl} alt="" className="mt-2 max-h-48 rounded-lg object-cover" />
          )}

          {item.price !== null && (
            <p className="mt-2 text-sm font-medium">{item.price} ETH</p>
          )}

          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => handleReact(item.id)}
              disabled={!accessToken}
              className="flex items-center gap-1 text-xs text-gray-500 transition-colors hover:text-purple-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span>&#128293;</span>
              <span>{item.reactions.length}</span>
            </button>
            {item.tokenId && (
              <span className="text-xs text-gray-600">Token #{item.tokenId}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
