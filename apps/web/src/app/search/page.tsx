import Link from 'next/link';
import { SearchBar } from '@/components/search/search-bar';
import { apiFetch } from '@/lib/api';
import { truncateAddress, formatPrice } from '@/lib/utils';

interface SearchPageProps {
  searchParams: Promise<{ q?: string; chain?: string }>;
}

interface SearchResults {
  projects: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    imageUrl: string | null;
    healthScore: number | null;
    collections: { id: string; name: string; chain: string; floorPrice: number | null }[];
  }[];
  collections: {
    id: string;
    name: string;
    contractAddress: string;
    chain: string;
    floorPrice: number | null;
    holderCount: number | null;
    imageUrl: string | null;
    project: { id: string; name: string; slug: string };
  }[];
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const { q, chain } = await searchParams;

  let results: SearchResults | null = null;
  if (q) {
    try {
      const params = new URLSearchParams({ q });
      if (chain) params.set('chain', chain);
      results = await apiFetch<SearchResults>(`/search?${params.toString()}`);
    } catch {
      // Search failed silently
    }
  }

  const hasResults = results && (results.projects.length > 0 || results.collections.length > 0);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-8">
        <SearchBar />
      </div>

      {!q && (
        <p className="text-gray-500">Search for a project, collection, or contract address.</p>
      )}

      {q && !hasResults && (
        <p className="text-gray-500">No results found for &ldquo;{q}&rdquo;</p>
      )}

      {results && results.projects.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-4 text-lg font-semibold text-gray-300">Projects</h2>
          <div className="space-y-3">
            {results.projects.map((p) => (
              <Link
                key={p.id}
                href={`/project/${p.slug}`}
                className="flex items-center gap-4 rounded-xl border border-gray-800 px-4 py-3 transition-colors hover:border-gray-600"
              >
                {p.imageUrl && (
                  <img src={p.imageUrl} alt={p.name} className="h-12 w-12 rounded-lg object-cover" />
                )}
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{p.name}</h3>
                    {p.healthScore !== null && (
                      <span className="text-xs text-gray-500">Score: {p.healthScore}</span>
                    )}
                  </div>
                  {p.description && (
                    <p className="mt-0.5 text-sm text-gray-500 line-clamp-1">{p.description}</p>
                  )}
                </div>
                <span className="text-sm text-gray-500">{p.collections.length} collection{p.collections.length !== 1 ? 's' : ''}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {results && results.collections.length > 0 && (
        <section>
          <h2 className="mb-4 text-lg font-semibold text-gray-300">Collections</h2>
          <div className="space-y-3">
            {results.collections.map((c) => (
              <Link
                key={c.id}
                href={`/project/${c.project.slug}/${c.contractAddress}`}
                className="flex items-center gap-4 rounded-xl border border-gray-800 px-4 py-3 transition-colors hover:border-gray-600"
              >
                {c.imageUrl && (
                  <img src={c.imageUrl} alt={c.name} className="h-12 w-12 rounded-lg object-cover" />
                )}
                <div className="flex-1">
                  <h3 className="font-medium">{c.name}</h3>
                  <p className="text-sm text-gray-500">
                    {c.project.name} · {c.chain} · {truncateAddress(c.contractAddress)}
                  </p>
                </div>
                <div className="text-right text-sm">
                  {c.floorPrice !== null && (
                    <p>{formatPrice(c.floorPrice, c.chain === 'solana' ? 'SOL' : 'ETH')}</p>
                  )}
                  {c.holderCount !== null && (
                    <p className="text-gray-500">{c.holderCount.toLocaleString()} holders</p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
