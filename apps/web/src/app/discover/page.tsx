'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGate } from '@/components/wallet/auth-gate';
import { useAuth } from '@/context/auth-context';
import { apiFetch } from '@/lib/api';

interface Recommendation {
  project: {
    id: string;
    name: string;
    slug: string;
    imageUrl: string | null;
    description: string | null;
    healthScore: number | null;
    collections: { id: string }[];
  };
  overlapCount: number;
  overlapPct: number;
}

interface EchoScore {
  walletAddress: string;
  echoScore: number | null;
  label: string | null;
}

export default function DiscoverPage() {
  return (
    <AuthGate>
      <DiscoverContent />
    </AuthGate>
  );
}

function DiscoverContent() {
  const { user } = useAuth();
  const address = user?.wallets[0]?.address;

  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [echoScore, setEchoScore] = useState<EchoScore | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    Promise.all([
      apiFetch<Recommendation[]>(`/discovery/recommendations/${address}`).catch(() => []),
      apiFetch<EchoScore>(`/discovery/echo-score/${address}`).catch(() => null),
    ]).then(([recs, score]) => {
      setRecommendations(recs);
      setEchoScore(score);
      setLoading(false);
    });
  }, [address]);

  if (loading) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
          <span className="text-gray-400">Analyzing your portfolio...</span>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-3xl font-bold">Discover</h1>
      <p className="mt-2 text-gray-400">Personalized recommendations based on your holdings.</p>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3">
        {/* Echo Score Card */}
        <section className="lg:col-span-1">
          <h2 className="mb-4 text-lg font-semibold text-gray-300">Echo Chamber Score</h2>
          {echoScore?.echoScore !== null ? (
            <div className="rounded-xl border border-gray-800 p-6 text-center">
              <div className={`mx-auto flex h-24 w-24 items-center justify-center rounded-full text-3xl font-bold ${
                (echoScore?.echoScore ?? 0) >= 70 ? 'bg-red-900/30 text-red-400' :
                (echoScore?.echoScore ?? 0) >= 40 ? 'bg-yellow-900/30 text-yellow-400' :
                'bg-green-900/30 text-green-400'
              }`}>
                {echoScore?.echoScore}
              </div>
              <p className="mt-3 text-lg font-medium">{echoScore?.label}</p>
              <p className="mt-1 text-sm text-gray-500">
                {(echoScore?.echoScore ?? 0) >= 70
                  ? 'Your portfolio is concentrated in similar communities.'
                  : (echoScore?.echoScore ?? 0) >= 40
                  ? 'You have a balanced mix of communities.'
                  : 'You explore diverse communities — nice!'}
              </p>
              <Link
                href="/me/card"
                className="mt-4 inline-block rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium transition-colors hover:bg-purple-500"
              >
                Share Score Card
              </Link>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-800 p-6 text-center">
              <p className="text-sm text-gray-500">
                Hold NFTs from multiple projects to see your echo chamber score.
              </p>
            </div>
          )}
        </section>

        {/* Recommendations */}
        <section className="lg:col-span-2">
          <h2 className="mb-4 text-lg font-semibold text-gray-300">Recommended for You</h2>
          {recommendations.length === 0 ? (
            <div className="rounded-xl border border-gray-800 p-6">
              <p className="text-sm text-gray-500">
                No recommendations yet. As more projects and holders are indexed, personalized suggestions will appear here based on community overlap.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {recommendations.map((rec) => (
                <Link
                  key={rec.project.id}
                  href={`/project/${rec.project.slug}`}
                  className="flex items-center gap-4 rounded-xl border border-gray-800 px-4 py-3 transition-colors hover:border-gray-600"
                >
                  {rec.project.imageUrl && (
                    <img src={rec.project.imageUrl} alt={rec.project.name} className="h-12 w-12 rounded-lg object-cover" />
                  )}
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">{rec.project.name}</h3>
                      {rec.project.healthScore !== null && (
                        <span className={`text-xs ${
                          rec.project.healthScore >= 70 ? 'text-green-400' :
                          rec.project.healthScore >= 40 ? 'text-yellow-400' : 'text-red-400'
                        }`}>
                          Score: {rec.project.healthScore}
                        </span>
                      )}
                    </div>
                    {rec.project.description && (
                      <p className="mt-0.5 text-sm text-gray-500 line-clamp-1">{rec.project.description}</p>
                    )}
                  </div>
                  <div className="text-right text-sm">
                    <p className="font-medium text-purple-400">{rec.overlapCount} holders overlap</p>
                    <p className="text-xs text-gray-500">{(rec.overlapPct * 100).toFixed(1)}% overlap</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
