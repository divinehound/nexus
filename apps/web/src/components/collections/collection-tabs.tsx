'use client';

import { useState } from 'react';
import { RelatedCollections } from './related-collections';
import { NetworkGraphVisualization } from '../discovery/network-graph-enhanced';

interface CollectionTabsProps {
  collectionId: string;
  chain: string;
}

export function CollectionTabs({ collectionId, chain }: CollectionTabsProps) {
  const [activeTab, setActiveTab] = useState<'related' | 'overlap'>('related');

  return (
    <div className="mt-8">
      {/* Tabs */}
      <div className="border-b border-gray-800">
        <div className="flex gap-4">
          <button
            onClick={() => setActiveTab('related')}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'related'
                ? 'border-purple-500 text-purple-400'
                : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            Related Collections
          </button>
          <button
            onClick={() => setActiveTab('overlap')}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'overlap'
                ? 'border-purple-500 text-purple-400'
                : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            Community Overlap
          </button>
        </div>
      </div>

      {/* Tab Content */}
      <div className="mt-6">
        {activeTab === 'related' && <RelatedCollections collectionId={collectionId} />}
        {activeTab === 'overlap' && (
          <NetworkGraphVisualization
            maxNodes={30}
            minSharedHolders={3}
            initialFocusedNodeId={collectionId}
          />
        )}
      </div>
    </div>
  );
}
