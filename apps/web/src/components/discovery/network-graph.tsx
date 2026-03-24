'use client';

import { useEffect, useRef, useState } from 'react';
import { getNetworkGraph, type NetworkGraph, type NetworkGraphNode } from '@/lib/api';
import Link from 'next/link';

interface NetworkGraphProps {
  strategy?: 'top-collections' | 'connected-traverse';
  maxNodes?: number;
  minSharedHolders?: number;
  chains?: string[];
  height?: number;
  initialFocusedNodeId?: string;
}

// Chain color mapping
const CHAIN_COLORS: Record<string, string> = {
  ethereum: '#627eea',
  base: '#0052ff',
  polygon: '#8247e5',
  arbitrum: '#28a0f0',
  optimism: '#ff0420',
  avalanche: '#e84142',
  bsc: '#f3ba2f',
  solana: '#14f195',
  abstract: '#a78bfa',
  apechain: '#fbbf24',
};

function getChainColor(chain: string): string {
  return CHAIN_COLORS[chain.toLowerCase()] || '#8b5cf6';
}

export function NetworkGraphVisualization({
  strategy,
  maxNodes = 50,
  minSharedHolders = 5,
  chains,
  height = 600,
  initialFocusedNodeId,
}: NetworkGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [data, setData] = useState<NetworkGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusedNode, setFocusedNode] = useState<string | null>(initialFocusedNodeId || null);
  const [navigationStack, setNavigationStack] = useState<string[]>([]);

  useEffect(() => {
    loadData();
  }, [strategy, maxNodes, minSharedHolders, chains, initialFocusedNodeId]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const graph = await getNetworkGraph({ 
        strategy,
        maxNodes, 
        minSharedHolders, 
        chains,
        focusCollectionId: initialFocusedNodeId,
      });
      setData(graph);
    } catch (err: any) {
      setError(err.message || 'Failed to load network graph');
    } finally {
      setLoading(false);
    }
  };

  const handleNodeClick = (nodeId: string) => {
    if (focusedNode === nodeId) {
      // Double-click behavior: go back
      handleGoBack();
    } else {
      // First click: zoom to node
      if (focusedNode) {
        setNavigationStack([...navigationStack, focusedNode]);
      }
      setFocusedNode(nodeId);
    }
  };

  const handleGoBack = () => {
    if (navigationStack.length > 0) {
      const previous = navigationStack[navigationStack.length - 1];
      setFocusedNode(previous);
      setNavigationStack(navigationStack.slice(0, -1));
    } else {
      setFocusedNode(null);
    }
  };

  const handleResetView = () => {
    setFocusedNode(null);
    setNavigationStack([]);
  };

  useEffect(() => {
    if (!data || !svgRef.current) return;

    const svg = svgRef.current;
    const width = svg.clientWidth;
    const height = svg.clientHeight;

    // Filter nodes/edges based on focus
    let visibleNodes = data.nodes;
    let visibleEdges = data.edges;

    if (focusedNode) {
      // Show only the focused node and its direct connections
      const connectedNodeIds = new Set([focusedNode]);
      data.edges.forEach((edge) => {
        if (edge.source === focusedNode) connectedNodeIds.add(edge.target);
        if (edge.target === focusedNode) connectedNodeIds.add(edge.source);
      });
      visibleNodes = data.nodes.filter((n) => connectedNodeIds.has(n.id));
      visibleEdges = data.edges.filter(
        (e) => e.source === focusedNode || e.target === focusedNode,
      );
    }

    // Simple force-directed layout simulation
    const nodes = visibleNodes.map((n, i) => ({
      ...n,
      // Spread initial positions across full canvas
      x: 50 + Math.random() * (width - 100),
      y: 50 + Math.random() * (height - 100),
      vx: 0,
      vy: 0,
    }));

    const edges = visibleEdges;

    // Physics simulation
    const simulate = () => {
      const alpha = 0.3;
      const centerForce = focusedNode ? 0.015 : 0.003; // Weaker center force, stronger when focused
      const repelForce = focusedNode ? 3000 : 5000; // Stronger repulsion to spread nodes
      const attractForce = 0.08; // Stronger attraction for connected nodes

      // Repel nodes from each other
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = repelForce / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          nodes[i].vx -= fx;
          nodes[i].vy -= fy;
          nodes[j].vx += fx;
          nodes[j].vy += fy;
        }
      }

      // Attract connected nodes
      edges.forEach((edge) => {
        const source = nodes.find((n) => n.id === edge.source);
        const target = nodes.find((n) => n.id === edge.target);
        if (!source || !target) return;

        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = edge.weight * attractForce * dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        source.vx += fx;
        source.vy += fy;
        target.vx -= fx;
        target.vy -= fy;
      });

      // Pull toward center
      nodes.forEach((node) => {
        node.vx += (width / 2 - node.x) * centerForce;
        node.vy += (height / 2 - node.y) * centerForce;
      });

      // Apply velocity with damping
      nodes.forEach((node) => {
        node.x += node.vx * alpha;
        node.y += node.vy * alpha;
        node.vx *= 0.85; // Slightly less damping for more movement
        node.vy *= 0.85;

        // Keep in bounds with more padding
        const padding = 60;
        node.x = Math.max(padding, Math.min(width - padding, node.x));
        node.y = Math.max(padding, Math.min(height - padding, node.y));
      });
    };

    // Run simulation (more iterations for better spacing)
    const iterations = focusedNode ? 150 : 200;
    for (let i = 0; i < iterations; i++) {
      simulate();
    }

    // Render
    const g = svg.querySelector('g');
    const defs = svg.querySelector('defs');
    if (!g || !defs) return;

    // Clear previous (including old defs content)
    g.innerHTML = '';
    // Clear old gradients/clips but keep the style element
    Array.from(defs.children).forEach((child) => {
      if (child.tagName !== 'style') {
        child.remove();
      }
    });

    // Draw edges
    edges.forEach((edge) => {
      const source = nodes.find((n) => n.id === edge.source);
      const target = nodes.find((n) => n.id === edge.target);
      if (!source || !target) return;

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', source.x.toString());
      line.setAttribute('y1', source.y.toString());
      line.setAttribute('x2', target.x.toString());
      line.setAttribute('y2', target.y.toString());
      line.setAttribute('stroke', '#374151');
      line.setAttribute('stroke-width', (edge.weight * 3).toString());
      line.setAttribute('stroke-opacity', '0.4');
      g.appendChild(line);
    });

    // Draw nodes
    nodes.forEach((node) => {
      const nodeG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      nodeG.setAttribute('data-node-id', node.id);
      nodeG.style.cursor = 'pointer';

      const isFocused = node.id === focusedNode;
      const isConnectedToFocused = focusedNode
        ? edges.some((e) => (e.source === focusedNode && e.target === node.id) || (e.target === focusedNode && e.source === node.id))
        : false;

      // Scale radius based on holder count (focused nodes get bigger)
      const baseRadius = Math.sqrt(node.holderCount) / 3 + 8;
      const radius = isFocused ? baseRadius * 1.5 : baseRadius;
      
      // Chain-based colors
      const chainColor = getChainColor(node.chain);
      const gradientId = `gradient-${node.id}`;
      
      // Create gradient for this node
      const defs = svg.querySelector('defs');
      const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
      gradient.setAttribute('id', gradientId);
      
      const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      stop1.setAttribute('offset', '0%');
      stop1.setAttribute('stop-color', chainColor);
      stop1.setAttribute('stop-opacity', '1');
      
      const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      stop2.setAttribute('offset', '70%');
      stop2.setAttribute('stop-color', chainColor);
      stop2.setAttribute('stop-opacity', '0.9');
      
      const stop3 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      stop3.setAttribute('offset', '100%');
      stop3.setAttribute('stop-color', chainColor);
      stop3.setAttribute('stop-opacity', '0.7');
      
      gradient.appendChild(stop1);
      gradient.appendChild(stop2);
      gradient.appendChild(stop3);
      defs?.appendChild(gradient);
      
      // Node circle with gradient fill and strong border
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', node.x.toString());
      circle.setAttribute('cy', node.y.toString());
      circle.setAttribute('r', radius.toString());
      circle.setAttribute('fill', `url(#${gradientId})`);
      circle.setAttribute('stroke', isFocused ? '#ffffff' : '#1f2937');
      circle.setAttribute('stroke-width', isFocused ? '3' : '2.5');
      circle.setAttribute('opacity', isFocused || !focusedNode || isConnectedToFocused ? '1' : '0.3');
      nodeG.appendChild(circle);

      // Collection image overlay (if available)
      if (node.imageUrl) {
        const clipId = `clip-${node.id}`;
        
        // Create circular clip path for image
        const clipPath = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
        clipPath.setAttribute('id', clipId);
        const clipCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        clipCircle.setAttribute('cx', node.x.toString());
        clipCircle.setAttribute('cy', node.y.toString());
        clipCircle.setAttribute('r', (radius * 0.7).toString()); // 70% of bubble size
        clipPath.appendChild(clipCircle);
        defs?.appendChild(clipPath);
        
        // Image element
        const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        image.setAttribute('href', node.imageUrl);
        image.setAttribute('x', (node.x - radius * 0.7).toString());
        image.setAttribute('y', (node.y - radius * 0.7).toString());
        image.setAttribute('width', (radius * 1.4).toString());
        image.setAttribute('height', (radius * 1.4).toString());
        image.setAttribute('clip-path', `url(#${clipId})`);
        image.setAttribute('opacity', isFocused || !focusedNode || isConnectedToFocused ? '0.95' : '0.3');
        image.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        nodeG.appendChild(image);
      }

      // Node label (always render, but hide with CSS for non-focused)
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', node.x.toString());
      text.setAttribute('y', (node.y + radius + 14).toString());
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', '#f3f4f6');
      text.setAttribute('font-size', isFocused ? '12' : '10');
      text.setAttribute('font-weight', isFocused ? 'bold' : 'normal');
      text.setAttribute('class', isFocused || !focusedNode ? 'node-label-visible' : 'node-label-hover');
      text.textContent = node.name.length > 20 ? node.name.slice(0, 18) + '...' : node.name;
      nodeG.appendChild(text);

      // Click event only (no hover state changes to avoid re-renders)
      nodeG.addEventListener('click', () => handleNodeClick(node.id));

      g.appendChild(nodeG);
    });
  }, [data, focusedNode]);

  if (loading) {
    return (
      <div className="flex h-[600px] items-center justify-center rounded-xl border border-gray-800 bg-gray-900/50">
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
          <span className="text-gray-400">Loading network graph...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-6">
        <p className="text-sm text-red-200">{error}</p>
        <button
          onClick={loadData}
          className="mt-3 rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 text-center">
        <p className="text-gray-400">No collections with holder data yet</p>
        <p className="mt-2 text-sm text-gray-500">
          Collections need to be indexed to appear in the network graph
        </p>
      </div>
    );
  }

  const focusedNodeData = focusedNode ? data.nodes.find((n) => n.id === focusedNode) : null;
  const connectedNodes = focusedNode
    ? data.nodes
        .filter((n) =>
          data.edges.some(
            (e) =>
              (e.source === focusedNode && e.target === n.id) ||
              (e.target === focusedNode && e.source === n.id),
          ),
        )
        .sort((a, b) => {
          // Sort by overlap percentage (weight), then by absolute count
          const edgeA = data.edges.find(
            (e) =>
              (e.source === focusedNode && e.target === a.id) ||
              (e.target === focusedNode && e.source === a.id),
          );
          const edgeB = data.edges.find(
            (e) =>
              (e.source === focusedNode && e.target === b.id) ||
              (e.target === focusedNode && e.source === b.id),
          );
          
          // Primary sort: overlap percentage (weight)
          const weightDiff = (edgeB?.weight || 0) - (edgeA?.weight || 0);
          if (Math.abs(weightDiff) > 0.01) return weightDiff;
          
          // Secondary sort: absolute count (for ties)
          return (edgeB?.sharedHolders || 0) - (edgeA?.sharedHolders || 0);
        })
    : [];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-100">
              {focusedNodeData ? `Exploring: ${focusedNodeData.name}` : 'Collection Network'}
            </h3>
            <p className="text-sm text-gray-400">
              {focusedNode
                ? `${connectedNodes.length} connected collections`
                : `${data.nodes.length} collections • ${data.edges.length} connections`}
            </p>
          </div>
          <div className="flex gap-2">
            {focusedNode && navigationStack.length > 0 && (
              <button
                onClick={handleGoBack}
                className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
              >
                ← Back
              </button>
            )}
            {focusedNode && (
              <button
                onClick={handleResetView}
                className="rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-600"
              >
                Reset View
              </button>
            )}
          </div>
        </div>
        <svg
          ref={svgRef}
          className="w-full rounded-lg bg-gray-950"
          style={{ height: `${height}px` }}
          viewBox={`0 0 1000 ${height}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <style>{`
              .node-label-visible { opacity: 1; }
              .node-label-hover { opacity: 0; transition: opacity 0.15s ease-out; }
              g[data-node-id]:hover .node-label-hover { opacity: 1; }
              g[data-node-id] circle { transition: stroke-width 0.15s ease-out; }
              g[data-node-id]:hover circle { stroke-width: 3; }
            `}</style>
          </defs>
          <g />
        </svg>
        
        {/* Chain legend */}
        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          <span className="text-gray-500">Chains:</span>
          {Array.from(new Set(data.nodes.map((n) => n.chain))).map((chain) => (
            <div key={chain} className="flex items-center gap-1.5">
              <div
                className="h-3 w-3 rounded-full border border-gray-700"
                style={{ backgroundColor: getChainColor(chain) }}
              />
              <span className="text-gray-400">{chain}</span>
            </div>
          ))}
        </div>
      </div>

      {focusedNode && connectedNodes.length > 0 && (
        <div className="rounded-xl border border-purple-900/50 bg-purple-950/30 p-4">
          <h4 className="mb-3 font-medium text-gray-100">
            Collections that share holders with {focusedNodeData?.name}
          </h4>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {connectedNodes.map((node) => {
              const edge = data.edges.find(
                (e) =>
                  (e.source === focusedNode && e.target === node.id) ||
                  (e.target === focusedNode && e.source === node.id),
              );
              return (
                <button
                  key={node.id}
                  onClick={() => handleNodeClick(node.id)}
                  className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/50 p-2 text-left transition-colors hover:border-purple-700 hover:bg-gray-900"
                >
                  {node.imageUrl ? (
                    <img
                      src={node.imageUrl}
                      alt={node.name}
                      className="h-10 w-10 flex-shrink-0 rounded border border-gray-700 object-cover"
                    />
                  ) : (
                    <div className="h-10 w-10 flex-shrink-0 rounded border border-gray-700 bg-gray-800 flex items-center justify-center">
                      <span className="text-xs text-gray-600">NFT</span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-gray-200">{node.name}</p>
                    <p className="text-xs text-gray-500">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: getChainColor(node.chain) }}
                      />{' '}
                      {node.chain} • {edge?.sharedHolders || 0} shared
                      {edge?.holderDataReliable && ` (${Math.round((edge?.weight || 0) * 100)}%)`}
                    </p>
                  </div>
                  <div className="text-xs text-purple-400">→</div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
