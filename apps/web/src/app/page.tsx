import Link from 'next/link';
import { SearchBar } from '@/components/search/search-bar';
import { apiFetch } from '@/lib/api';

interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  healthScore: number | null;
  collections: { id: string; floorPrice: number | null; chain: string }[];
}

async function getTrending(): Promise<ProjectSummary[]> {
  try {
    return await apiFetch<ProjectSummary[]>('/projects/trending');
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const trending = await getTrending();

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-7xl px-4 py-16">
        <div className="text-center">
          <h1 className="text-6xl font-bold tracking-tight">NEXUS</h1>
          <p className="mt-4 text-xl text-gray-400">
            The Dexscreener for NFT Projects &amp; Communities
          </p>
          <div className="mx-auto mt-8 max-w-2xl">
            <SearchBar />
          </div>
        </div>

        <div className="mt-20 grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">
          <section>
            <h2 className="mb-4 text-lg font-semibold text-gray-300">Trending</h2>
            {trending.length === 0 ? (
              <p className="text-sm text-gray-500">No trending projects yet.</p>
            ) : (
              <div className="space-y-2">
                {trending.slice(0, 5).map((p, i) => (
                  <Link
                    key={p.id}
                    href={`/project/${p.slug}`}
                    className="flex items-center gap-3 rounded-lg border border-gray-800 px-3 py-2 transition-colors hover:border-gray-600"
                  >
                    <span className="w-5 text-sm text-gray-500">{i + 1}</span>
                    {p.imageUrl && (
                      <img src={p.imageUrl} alt={p.name} className="h-8 w-8 rounded-lg object-cover" />
                    )}
                    <span className="flex-1 text-sm font-medium">{p.name}</span>
                    {p.healthScore !== null && (
                      <span className={`text-xs ${
                        p.healthScore >= 70 ? 'text-green-400' :
                        p.healthScore >= 40 ? 'text-yellow-400' : 'text-red-400'
                      }`}>
                        {p.healthScore}
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-4 text-lg font-semibold text-red-400">Live Now</h2>
            <p className="text-sm text-gray-500">No active Spaces</p>
          </section>

          <section>
            <h2 className="mb-4 text-lg font-semibold text-gray-300">Most Active</h2>
            {trending.length === 0 ? (
              <p className="text-sm text-gray-500">No active projects yet.</p>
            ) : (
              <div className="space-y-2">
                {trending.slice(0, 5).map((p) => (
                  <Link
                    key={p.id}
                    href={`/project/${p.slug}`}
                    className="flex items-center gap-3 rounded-lg border border-gray-800 px-3 py-2 transition-colors hover:border-gray-600"
                  >
                    {p.imageUrl && (
                      <img src={p.imageUrl} alt={p.name} className="h-8 w-8 rounded-lg object-cover" />
                    )}
                    <span className="flex-1 text-sm font-medium">{p.name}</span>
                    <span className="text-xs text-gray-500">{p.collections.length} collections</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
