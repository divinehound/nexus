'use client';

import { AuthGate } from '@/components/wallet/auth-gate';
import { useAuth } from '@/context/auth-context';
import { truncateAddress } from '@/lib/utils';

export default function MyCommunitiesPage() {
  return (
    <AuthGate>
      <MyCommunitiesContent />
    </AuthGate>
  );
}

function MyCommunitiesContent() {
  const { user } = useAuth();

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-3xl font-bold">My Communities</h1>
      <p className="mt-2 text-gray-400">
        Signed in as {user?.wallets[0]?.ensName || user?.wallets[0]?.snsName || truncateAddress(user?.wallets[0]?.address || '')}
      </p>
      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-4 text-lg font-semibold text-gray-300">My Projects</h2>
          <p className="text-sm text-gray-500">Projects from your holdings will appear here.</p>
        </section>
        <section>
          <h2 className="mb-4 text-lg font-semibold text-gray-300">My Events</h2>
          <p className="text-sm text-gray-500">Events from your held projects will appear here.</p>
        </section>
      </div>
    </main>
  );
}
