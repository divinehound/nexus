'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SearchBar() {
  const [query, setQuery] = useState('');
  const router = useRouter();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      router.push(`/search?q=${encodeURIComponent(query.trim())}`);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
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
