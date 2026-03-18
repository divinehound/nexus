'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGate } from '@/components/wallet/auth-gate';
import { useAuth } from '@/context/auth-context';
import { apiFetch } from '@/lib/api';
import { truncateAddress, formatPrice } from '@/lib/utils';

interface Holding {
  project: { id: string; name: string; slug: string; imageUrl: string | null };
  collections: { collection: { id: string; name: string; chain: string; floorPrice: number | null }; quantity: number }[];
}

interface MyEvent {
  id: string;
  title: string;
  eventType: string;
  startTime: string;
  status: string;
  link: string | null;
}

interface MyActivity {
  id: string;
  activityType: string;
  walletAddress: string | null;
  price: number | null;
  message: string | null;
  createdAt: string;
}

export default function MyCommunitiesPage() {
  return (
    <AuthGate>
      <MyCommunitiesContent />
    </AuthGate>
  );
}

function MyCommunitiesContent() {
  const { user } = useAuth();
  const address = user?.wallets[0]?.address;

  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [events, setEvents] = useState<MyEvent[]>([]);
  const [activity, setActivity] = useState<MyActivity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    Promise.all([
      apiFetch<Holding[]>(`/wallets/${address}/holdings`).catch(() => []),
      apiFetch<MyEvent[]>(`/wallets/${address}/events`).catch(() => []),
      apiFetch<MyActivity[]>(`/wallets/${address}/activity`).catch(() => []),
    ]).then(([h, e, a]) => {
      setHoldings(h);
      setEvents(e);
      setActivity(a);
      setLoading(false);
    });
  }, [address]);

  if (loading) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
          <span className="text-gray-400">Loading your communities...</span>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-3xl font-bold">My Communities</h1>
      <p className="mt-2 text-gray-400">
        Signed in as {user?.wallets[0]?.ensName || user?.wallets[0]?.snsName || truncateAddress(address || '')}
      </p>

      {/* Holdings */}
      <section className="mt-8">
        <h2 className="mb-4 text-lg font-semibold text-gray-300">
          My Projects ({holdings.length})
        </h2>
        {holdings.length === 0 ? (
          <p className="text-sm text-gray-500">No holdings found for this wallet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {holdings.map((h) => (
              <Link
                key={h.project.id}
                href={`/project/${h.project.slug}`}
                className="rounded-xl border border-gray-800 p-4 transition-colors hover:border-gray-600"
              >
                <div className="flex items-center gap-3">
                  {h.project.imageUrl && (
                    <img src={h.project.imageUrl} alt={h.project.name} className="h-10 w-10 rounded-lg object-cover" />
                  )}
                  <h3 className="font-medium">{h.project.name}</h3>
                </div>
                <div className="mt-3 space-y-1">
                  {h.collections.map((c) => (
                    <div key={c.collection.id} className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">{c.collection.name}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500">x{c.quantity}</span>
                        {c.collection.floorPrice !== null && (
                          <span>{formatPrice(c.collection.floorPrice, c.collection.chain === 'solana' ? 'SOL' : 'ETH')}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-2">
        {/* Events */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-gray-300">Upcoming Events</h2>
          {events.length === 0 ? (
            <p className="text-sm text-gray-500">No upcoming events from your communities.</p>
          ) : (
            <div className="space-y-2">
              {events.map((e) => (
                <div key={e.id} className="rounded-lg border border-gray-800 px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className={`mr-2 text-xs font-medium uppercase ${
                        e.status === 'live' ? 'text-red-400' : 'text-green-400'
                      }`}>
                        {e.status}
                      </span>
                      <span className="text-sm font-medium">{e.title}</span>
                    </div>
                    <span className="text-xs text-gray-500">
                      {new Date(e.startTime).toLocaleDateString()}
                    </span>
                  </div>
                  {e.link && (
                    <a href={e.link} target="_blank" rel="noopener noreferrer" className="mt-1 block text-xs text-purple-400 hover:text-purple-300">
                      Open link
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Activity */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-gray-300">Recent Activity</h2>
          {activity.length === 0 ? (
            <p className="text-sm text-gray-500">No recent activity from your communities.</p>
          ) : (
            <div className="space-y-2">
              {activity.map((a) => (
                <div key={a.id} className="rounded-lg border border-gray-800 px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-xs ${
                        a.activityType === 'sale' ? 'bg-green-900/30 text-green-400' :
                        a.activityType === 'flex' ? 'bg-purple-900/30 text-purple-400' :
                        'bg-gray-800 text-gray-400'
                      }`}>
                        {a.activityType}
                      </span>
                      {a.walletAddress && (
                        <span className="text-xs text-gray-500">{truncateAddress(a.walletAddress)}</span>
                      )}
                    </div>
                    <span className="text-xs text-gray-500">
                      {new Date(a.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  {a.message && <p className="mt-1 text-sm text-gray-400">{a.message}</p>}
                  {a.price !== null && (
                    <p className="mt-1 text-sm font-medium">{a.price} ETH</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
