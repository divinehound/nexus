'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';

interface EventItem {
  id: string;
  projectId: string;
  title: string;
  eventType: string;
  startTime: string;
  status: 'upcoming' | 'live' | 'ended';
  source: string;
  link: string | null;
  createdAt: string;
}

export default function AdminEventsPage() {
  const { accessToken } = useAuth();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);

  const fetchEvents = () => {
    if (!accessToken) return;
    setLoading(true);
    const qs = filter ? `?status=${filter}` : '';
    apiFetch<EventItem[]>(`/admin/events${qs}`, { token: accessToken })
      .then(setEvents)
      .catch(() => [])
      .finally(() => setLoading(false));
  };

  useEffect(fetchEvents, [accessToken, filter]);

  const handleStatusChange = async (eventId: string, status: 'upcoming' | 'live' | 'ended') => {
    if (!accessToken) return;
    await apiFetch(`/admin/events/${eventId}/status`, {
      method: 'PATCH',
      token: accessToken,
      body: JSON.stringify({ status }),
    });
    fetchEvents();
  };

  const handleDelete = async (event: EventItem) => {
    if (!accessToken || !confirm(`Delete event "${event.title}"?`)) return;
    await apiFetch(`/admin/events/${event.id}`, {
      method: 'DELETE',
      token: accessToken,
    });
    fetchEvents();
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Events ({events.length})</h2>
        <div className="flex gap-1">
          {[
            { value: '', label: 'All' },
            { value: 'upcoming', label: 'Upcoming' },
            { value: 'live', label: 'Live' },
            { value: 'ended', label: 'Ended' },
          ].map((s) => (
            <button
              key={s.value}
              onClick={() => setFilter(s.value)}
              className={`rounded-lg px-3 py-1 text-sm ${
                filter === s.value ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
          <span className="text-gray-400">Loading...</span>
        </div>
      ) : events.length === 0 ? (
        <p className="text-gray-500">No events found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500">
                <th className="pb-3 pr-4 font-medium">Title</th>
                <th className="pb-3 pr-4 font-medium">Type</th>
                <th className="pb-3 pr-4 font-medium">Source</th>
                <th className="pb-3 pr-4 font-medium">Start</th>
                <th className="pb-3 pr-4 font-medium">Status</th>
                <th className="pb-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="py-3 pr-4">
                    <span className="font-medium">{e.title}</span>
                    {e.link && (
                      <a
                        href={e.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 text-xs text-purple-400 hover:text-purple-300"
                      >
                        link
                      </a>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-gray-400">{e.eventType}</td>
                  <td className="py-3 pr-4 text-gray-400">{e.source}</td>
                  <td className="py-3 pr-4 text-gray-400">
                    {new Date(e.startTime).toLocaleString()}
                  </td>
                  <td className="py-3 pr-4">
                    <select
                      value={e.status}
                      onChange={(ev) => handleStatusChange(e.id, ev.target.value as 'upcoming' | 'live' | 'ended')}
                      className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-white"
                    >
                      <option value="upcoming">Upcoming</option>
                      <option value="live">Live</option>
                      <option value="ended">Ended</option>
                    </select>
                  </td>
                  <td className="py-3">
                    <button
                      onClick={() => handleDelete(e)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
