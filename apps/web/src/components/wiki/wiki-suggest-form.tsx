'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';

interface WikiSuggestFormProps {
  projectId: string;
}

export function WikiSuggestForm({ projectId }: WikiSuggestFormProps) {
  const { user, accessToken } = useAuth();
  const [field, setField] = useState('descriptionMd');
  const [proposedValue, setProposedValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!accessToken) {
    return (
      <p className="text-sm text-gray-500">Connect your wallet to suggest wiki edits.</p>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!proposedValue.trim()) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await apiFetch('/wiki/suggest', {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({
          projectId,
          field,
          proposedValue: proposedValue.trim(),
          submittedBy: user?.id,
        }),
      });
      setProposedValue('');
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit suggestion');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-gray-800 p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-300">Suggest a Wiki Edit</h3>
      <select
        value={field}
        onChange={(e) => setField(e.target.value)}
        className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-purple-500"
      >
        <option value="descriptionMd">Description</option>
      </select>
      <textarea
        value={proposedValue}
        onChange={(e) => setProposedValue(e.target.value)}
        placeholder="Your proposed content (markdown supported)..."
        rows={4}
        className="mt-3 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500"
        required
      />
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {success && <p className="mt-2 text-xs text-green-400">Suggestion submitted for review!</p>}
      <button
        type="submit"
        disabled={submitting || !proposedValue.trim()}
        className="mt-3 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
      >
        {submitting ? 'Submitting...' : 'Submit Suggestion'}
      </button>
    </form>
  );
}
