import { SearchBar } from '@/components/search/search-bar';

interface SearchPageProps {
  searchParams: Promise<{ q?: string; chain?: string }>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const { q } = await searchParams;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-8">
        <SearchBar />
      </div>
      <h2 className="text-xl font-semibold">
        {q ? `Results for "${q}"` : 'Search for a project or collection'}
      </h2>
      {/* TODO: Fetch results from API, group by projects then collections */}
      <p className="mt-4 text-gray-500">No results yet.</p>
    </main>
  );
}
