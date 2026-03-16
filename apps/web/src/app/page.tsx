import { SearchBar } from '@/components/search/search-bar';

export default function HomePage() {
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
            <p className="text-sm text-gray-500">Coming soon</p>
          </section>
          <section>
            <h2 className="mb-4 text-lg font-semibold text-red-400">Live Now</h2>
            <p className="text-sm text-gray-500">No active Spaces</p>
          </section>
          <section>
            <h2 className="mb-4 text-lg font-semibold text-gray-300">Most Active</h2>
            <p className="text-sm text-gray-500">Coming soon</p>
          </section>
        </div>
      </div>
    </main>
  );
}
