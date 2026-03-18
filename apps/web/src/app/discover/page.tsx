'use client';

import { AuthGate } from '@/components/wallet/auth-gate';

export default function DiscoverPage() {
  return (
    <AuthGate>
      <DiscoverContent />
    </AuthGate>
  );
}

function DiscoverContent() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-3xl font-bold">Discover</h1>
      <p className="mt-4 text-gray-400">
        Personalized recommendations based on your holdings.
      </p>
      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-4 text-lg font-semibold text-gray-300">Recommended Projects</h2>
          <p className="text-sm text-gray-500">Recommendations will appear here based on holder overlap analysis.</p>
        </section>
        <section>
          <h2 className="mb-4 text-lg font-semibold text-gray-300">Echo Chamber Score</h2>
          <p className="text-sm text-gray-500">Your portfolio diversity score will appear here.</p>
        </section>
      </div>
    </main>
  );
}
