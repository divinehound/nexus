'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';

interface FlexFormProps {
  projectId: string;
  onSuccess?: () => void;
}

export function FlexForm({ projectId, onSuccess }: FlexFormProps) {
  const { accessToken } = useAuth();
  const [collectionId, setCollectionId] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!accessToken) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!collectionId || !tokenId) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/projects/${projectId}/activity/flex`, {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({
          collectionId,
          tokenId,
          message: message || undefined,
        }),
      });
      setCollectionId('');
      setTokenId('');
      setMessage('');
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post flex');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-gray-800 p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-300">Post a Flex</h3>
      <div className="grid grid-cols-2 gap-3">
        <input
          type="text"
          value={collectionId}
          onChange={(e) => setCollectionId(e.target.value)}
          placeholder="Collection ID"
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500"
          required
        />
        <input
          type="text"
          value={tokenId}
          onChange={(e) => setTokenId(e.target.value)}
          placeholder="Token ID"
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500"
          required
        />
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Say something about your purchase... (optional)"
        rows={2}
        className="mt-3 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500"
      />
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={submitting || !collectionId || !tokenId}
        className="mt-3 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
      >
        {submitting ? 'Posting...' : 'Post Flex'}
      </button>
    </form>
  );
}
