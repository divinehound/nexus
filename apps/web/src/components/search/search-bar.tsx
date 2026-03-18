'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Chain, CHAIN_META, chainDisplayName } from '@nexus/types';

const ALL_CHAINS = Object.values(Chain);

export function SearchBar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [chain, setChain] = useState(searchParams.get('chain') ?? '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      const params = new URLSearchParams({ q: query.trim() });
      if (chain) params.set('chain', chain);
      router.push(`/search?${params.toString()}`);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <select
        value={chain}
        onChange={(e) => setChain(e.target.value)}
        className="rounded-xl border border-gray-700 bg-gray-900 px-4 py-4 text-sm text-white outline-none transition-colors focus:border-purple-500"
      >
        <option value="">All Chains</option>
        {ALL_CHAINS.map((c) => (
          <option key={c} value={c}>
            {chainDisplayName(c)}
          </option>
        ))}
      </select>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search projects, collections, or paste a contract address..."
        className="w-full rounded-xl border border-gray-700 bg-gray-900 px-6 py-4 text-lg text-white placeholder-gray-500 outline-none transition-colors focus:border-purple-500"
      />
    </form>
  );
}
