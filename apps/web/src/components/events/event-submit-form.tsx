'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';

interface EventSubmitFormProps {
  projectId: string;
}

export function EventSubmitForm({ projectId }: EventSubmitFormProps) {
  const { user, accessToken } = useAuth();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [eventType, setEventType] = useState('spaces');
  const [startTime, setStartTime] = useState('');
  const [link, setLink] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!accessToken) {
    return (
      <p className="text-sm text-gray-500">Connect your wallet to submit events.</p>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !startTime) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await apiFetch(`/projects/${projectId}/events/submit`, {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          eventType,
          startTime,
          link: link.trim() || undefined,
          submittedBy: user?.id,
        }),
      });
      setTitle('');
      setDescription('');
      setStartTime('');
      setLink('');
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit event');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-gray-800 p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-300">Submit an Event</h3>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Event title"
        className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500"
        required
      />
      <div className="mt-3 grid grid-cols-2 gap-3">
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-purple-500"
        >
          <option value="spaces">Twitter Space</option>
          <option value="ama">AMA</option>
          <option value="mint">Mint</option>
          <option value="collab">Collab</option>
          <option value="irl">IRL</option>
          <option value="other">Other</option>
        </select>
        <input
          type="datetime-local"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-purple-500"
          required
        />
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
        className="mt-3 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500"
      />
      <input
        type="url"
        value={link}
        onChange={(e) => setLink(e.target.value)}
        placeholder="Link (optional)"
        className="mt-3 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500"
      />
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {success && <p className="mt-2 text-xs text-green-400">Event submitted!</p>}
      <button
        type="submit"
        disabled={submitting || !title.trim() || !startTime}
        className="mt-3 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
      >
        {submitting ? 'Submitting...' : 'Submit Event'}
      </button>
    </form>
  );
}
