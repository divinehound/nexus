'use client';

import { useState } from 'react';
import { ActivityFeed } from '@/components/activity/activity-feed';
import { FlexForm } from '@/components/activity/flex-form';
import { WikiSuggestForm } from '@/components/wiki/wiki-suggest-form';
import { EventSubmitForm } from '@/components/events/event-submit-form';

type Tab = 'overview' | 'wiki' | 'events' | 'activity';

interface ProjectTabsProps {
  projectId: string;
  wikiContent: string | null;
  events: {
    id: string;
    title: string;
    eventType: string;
    startTime: string;
    status: string;
    link: string | null;
  }[];
  children: React.ReactNode; // Overview content (collections grid)
}

export function ProjectTabs({ projectId, wikiContent, events, children }: ProjectTabsProps) {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [activityKey, setActivityKey] = useState(0);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'wiki', label: 'Wiki' },
    { id: 'events', label: `Events (${events.length})` },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <>
      <nav className="mt-6 flex gap-1 border-b border-gray-800">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`border-b-2 px-4 py-2 text-sm transition-colors ${
              activeTab === tab.id
                ? 'border-purple-500 text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="mt-6">
        {activeTab === 'overview' && children}

        {activeTab === 'wiki' && (
          <div className="space-y-6">
            {wikiContent ? (
              <div className="rounded-xl border border-gray-800 p-6 text-gray-300 whitespace-pre-wrap">
                {wikiContent}
              </div>
            ) : (
              <p className="text-sm text-gray-500">No wiki content yet. Be the first to contribute!</p>
            )}
            <WikiSuggestForm projectId={projectId} />
          </div>
        )}

        {activeTab === 'events' && (
          <div className="space-y-6">
            {events.length === 0 ? (
              <p className="text-sm text-gray-500">No events yet.</p>
            ) : (
              <div className="space-y-3">
                {events.map((e) => (
                  <div key={e.id} className="flex items-center justify-between rounded-xl border border-gray-800 px-4 py-3">
                    <div>
                      <span className={`mr-2 text-xs font-medium uppercase ${
                        e.status === 'live' ? 'text-red-400' :
                        e.status === 'upcoming' ? 'text-green-400' : 'text-gray-500'
                      }`}>
                        {e.status}
                      </span>
                      <span className="font-medium">{e.title}</span>
                      <span className="ml-2 text-xs text-gray-500">{e.eventType}</span>
                    </div>
                    <div className="text-sm text-gray-500">
                      {new Date(e.startTime).toLocaleDateString()}
                      {e.link && (
                        <a href={e.link} target="_blank" rel="noopener noreferrer" className="ml-3 text-purple-400 hover:text-purple-300">
                          Link
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <EventSubmitForm projectId={projectId} />
          </div>
        )}

        {activeTab === 'activity' && (
          <div className="space-y-6">
            <FlexForm projectId={projectId} onSuccess={() => setActivityKey((k) => k + 1)} />
            <ActivityFeed key={activityKey} projectId={projectId} />
          </div>
        )}
      </div>
    </>
  );
}
