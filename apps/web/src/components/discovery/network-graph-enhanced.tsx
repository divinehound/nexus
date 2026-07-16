'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { getNetworkGraph, getCollectionConnections, type NetworkGraph, type NetworkGraphNode } from '@/lib/api';
import Link from 'next/link';
import * as d3 from 'd3';

interface NetworkGraphProps {
  strategy?: 'top-collections' | 'connected-traverse' | 'user-network';
  maxNodes?: number;
  minSharedHolders?: number;
  chains?: string[];
  height?: number;
  initialFocusedNodeId?: string;
  userAddress?: string;
  userChain?: string;
}

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

type SimulationNode = d3.SimulationNodeDatum & NetworkGraphNode;
type SimulationLink = d3.SimulationLinkDatum<SimulationNode> & {
  weight: number;
  sharedHolders: number;
  holderDataReliable: boolean;
};

export function NetworkGraphVisualization({
  strategy,
  maxNodes = 50,
  minSharedHolders = 5,
  chains,
  height = 600,
  initialFocusedNodeId,
  userAddress,
  userChain,
}: NetworkGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<SimulationNode, SimulationLink> | null>(null);
  
  const [data, setData] = useState<NetworkGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusedNode, setFocusedNode] = useState<string | null>(initialFocusedNodeId || null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [expandingNode, setExpandingNode] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const width = 1000;

  useEffect(() => {
    loadData();
  }, [strategy, maxNodes, minSharedHolders, chains, initialFocusedNodeId, userAddress, userChain]);

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
        userAddress,
        userChain,
      });
      setData(graph);
    } catch (err: any) {
      setError(err.message || 'Failed to load network graph');
    } finally {
      setLoading(false);
    }
  };

  const focusOnNode = useCallback(async (nodeId: string) => {
    if (expandingNode === nodeId) return;

    setExpandingNode(nodeId);
    setFocusedNode(nodeId);
    
    try {
      // Fetch ONLY this node + its connections (clear everything else).
      // Same cap as the initial load so refocusing doesn't shrink the view.
      const { nodes: newNodes, edges: newEdges } = await getCollectionConnections(nodeId, {
        minSharedHolders,
        limit: Math.max(15, maxNodes - 1),
      });

      // Replace the entire graph (don't accumulate)
      setData({ nodes: newNodes, edges: newEdges });
      setExpandedNodes(new Set([nodeId]));
    } catch (err) {
      console.error('Failed to focus node:', err);
    } finally {
      setExpandingNode(null);
    }
  }, [minSharedHolders, expandingNode, maxNodes]);

  // D3 Force Simulation Rendering
  useEffect(() => {
    if (!data || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const container = svg.select('g.container');

    // Clear previous
    container.selectAll('*').remove();

    // Prepare data
    const nodes: SimulationNode[] = data.nodes.map(n => ({ ...n }));
    const links: SimulationLink[] = data.edges.map(e => ({
      source: e.source,
      target: e.target,
      weight: e.weight,
      sharedHolders: e.sharedHolders,
      holderDataReliable: e.holderDataReliable,
    }));

    // Create force simulation with reduced movement
    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink<SimulationNode, SimulationLink>(links)
        .id(d => d.id)
        .distance(d => 150 - (d.weight * 80)) // Slightly less variation
        .strength(d => d.weight * 0.3) // Weaker links = less pulling
      )
      .force('charge', d3.forceManyBody().strength(-600)) // Less repulsion
      .force('center', d3.forceCenter(width / 2, height / 2).strength(0.05)) // Weaker centering
      .force('collision', d3.forceCollide().radius(d => Math.sqrt(d.holderCount || 0) / 3 + 22))
      .velocityDecay(0.6) // Faster decay = settles quicker
      .alphaDecay(0.05); // Faster cooldown

    simulationRef.current = simulation;

    // Draw edges
    const link = container.append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', d => {
        // Highlight edges connected to focused node
        if (!focusedNode) return '#4b5563';
        const sourceId = (d.source as any).id || d.source;
        const targetId = (d.target as any).id || d.target;
        if (sourceId === focusedNode || targetId === focusedNode) {
          return '#8b5cf6'; // Purple for focused connections
        }
        return '#4b5563'; // Gray for others
      })
      .attr('stroke-width', d => {
        if (!focusedNode) return 1 + d.weight * 4;
        const sourceId = (d.source as any).id || d.source;
        const targetId = (d.target as any).id || d.target;
        if (sourceId === focusedNode || targetId === focusedNode) {
          return 2 + d.weight * 5; // Thicker for focused
        }
        return 1 + d.weight * 3;
      })
      .attr('stroke-opacity', d => {
        if (!focusedNode) return 0.6;
        const sourceId = (d.source as any).id || d.source;
        const targetId = (d.target as any).id || d.target;
        if (sourceId === focusedNode || targetId === focusedNode) {
          return 0.8; // More visible
        }
        return 0.2; // Dim others
      })
      .attr('class', 'transition-all duration-200');

    // Draw nodes
    const node = container.append('g')
      .attr('class', 'nodes')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('class', 'node-group cursor-pointer')
      .call(d3.drag<SVGGElement, SimulationNode>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended) as any
      )
      .on('click', (_event, d) => {
        // Single click: clear graph and refocus on this node
        focusOnNode(d.id);
      })
      .on('mouseenter', (_event, d) => setHoveredNode(d.id))
      .on('mouseleave', () => setHoveredNode(null));

    // Add circles
    node.append('circle')
      .attr('r', d => Math.sqrt(d.holderCount || 0) / 3 + 12)
      .attr('fill', d => getChainColor(d.chain))
      .attr('stroke', d => {
        if ((d as any).isUserHolding) return '#fbbf24'; // Gold for user holdings
        if (expandedNodes.has(d.id)) return '#10b981'; // Green for expanded
        return '#1f2937'; // Dark gray default
      })
      .attr('stroke-width', d => {
        if ((d as any).isUserHolding) return 3;
        if (focusedNode === d.id) return 4;
        return 2;
      })
      .attr('opacity', d => {
        if (!focusedNode) return 1;
        if (d.id === focusedNode) return 1;
        const isConnected = links.some(l => 
          (l.source === focusedNode && (l.target as any).id === d.id) ||
          ((l.source as any).id === focusedNode && l.target === d.id) ||
          (l.source === d.id && (l.target as any).id === focusedNode) ||
          ((l.source as any).id === d.id && l.target === focusedNode)
        );
        return isConnected ? 1 : 0.2;
      });

    // Add images (if available)
    node.filter(d => d.imageUrl)
      .append('image')
      .attr('xlink:href', d => d.imageUrl!)
      .attr('x', d => -(Math.sqrt(d.holderCount || 0) / 3 + 8))
      .attr('y', d => -(Math.sqrt(d.holderCount || 0) / 3 + 8))
      .attr('width', d => (Math.sqrt(d.holderCount || 0) / 3 + 8) * 2)
      .attr('height', d => (Math.sqrt(d.holderCount || 0) / 3 + 8) * 2)
      .attr('clip-path', d => `circle(${Math.sqrt(d.holderCount || 0) / 3 + 8}px)`)
      .attr('opacity', 0.8);

    // Add labels
    node.append('text')
      .text(d => d.name.length > 15 ? d.name.slice(0, 13) + '...' : d.name)
      .attr('text-anchor', 'middle')
      .attr('dy', d => Math.sqrt(d.holderCount || 0) / 3 + 24)
      .attr('font-size', d => focusedNode === d.id ? 12 : 10)
      .attr('font-weight', d => focusedNode === d.id ? 'bold' : 'normal')
      .attr('fill', '#f3f4f6')
      .attr('pointer-events', 'none');

    // Update positions on tick
    simulation.on('tick', () => {
      link
        .attr('x1', d => (d.source as any).x)
        .attr('y1', d => (d.source as any).y)
        .attr('x2', d => (d.target as any).x)
        .attr('y2', d => (d.target as any).y);

      node
        .attr('transform', d => `translate(${d.x},${d.y})`);
    });

    // Drag functions
    function dragstarted(event: any, d: SimulationNode) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(event: any, d: SimulationNode) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragended(event: any, d: SimulationNode) {
      if (!event.active) simulation.alphaTarget(0);
      // Keep node pinned (remove these lines to unpin on release)
      // d.fx = null;
      // d.fy = null;
    }

    // Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 3])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
      });

    svg.call(zoom as any);

    return () => {
      simulation.stop();
    };
  }, [data, focusedNode, expandedNodes, focusOnNode]);

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
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-8 text-center">
        <p className="text-gray-400">No network data available</p>
      </div>
    );
  }

  const focusedNodeData = data.nodes.find(n => n.id === focusedNode);

  // Collections directly sharing holders with the focused one, strongest first
  const connectedToFocus = focusedNode
    ? data.edges
        .filter(e => e.source === focusedNode || e.target === focusedNode)
        .map(e => {
          const otherId = e.source === focusedNode ? e.target : e.source;
          const node = data.nodes.find(n => n.id === otherId);
          return node ? { node, edge: e } : null;
        })
        .filter((x): x is { node: NetworkGraphNode; edge: NetworkGraph['edges'][number] } => x !== null)
        .sort(
          (a, b) =>
            b.edge.weight - a.edge.weight || b.edge.sharedHolders - a.edge.sharedHolders,
        )
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-300">
            {focusedNode && focusedNodeData
              ? `${connectedToFocus.length} collections share holders with ${focusedNodeData.name}`
              : `${data.nodes.length} Collections · ${data.edges.length} Connections`}
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            {focusedNode
              ? 'Gray lines are overlaps between the other collections shown · Click a node to refocus'
              : 'Click node to explore · Drag to reposition · Scroll to zoom · Purple lines = connections'}
          </p>
        </div>
        {focusedNode && (
          <button
            onClick={loadData}
            className="rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-600"
          >
            ← Back to Your Network
          </button>
        )}
      </div>

      <svg
        ref={svgRef}
        className="w-full rounded-lg border border-gray-800 bg-gray-950"
        style={{ height: `${height}px` }}
        viewBox={`0 0 ${width} ${height}`}
      >
        <g className="container" />
      </svg>

      {focusedNode && focusedNodeData && (
        <div className="rounded-xl border border-purple-900/50 bg-purple-950/30 p-4">
          <div className="flex items-center gap-3">
            {focusedNodeData.imageUrl && (
              <img
                src={focusedNodeData.imageUrl}
                alt={focusedNodeData.name}
                className="h-12 w-12 rounded border border-gray-700 object-cover"
              />
            )}
            <div>
              <h4 className="font-medium text-purple-200">{focusedNodeData.name}</h4>
              <p className="text-xs text-gray-400">
                {focusedNodeData.chain} · {focusedNodeData.holderCount?.toLocaleString()} holders
              </p>
            </div>
            <Link
              href={`/collection/${focusedNodeData.chain}/${focusedNodeData.contractAddress}`}
              className="ml-auto rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-600"
            >
              View Details →
            </Link>
          </div>

          {connectedToFocus.length > 0 && (
            <div className="mt-4">
              <h5 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
                Strongest overlaps
              </h5>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
                {connectedToFocus.map(({ node, edge }) => (
                  <button
                    key={node.id}
                    onClick={() => focusOnNode(node.id)}
                    className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/50 p-2 text-left transition-colors hover:border-purple-700 hover:bg-gray-900"
                  >
                    {node.imageUrl ? (
                      <img
                        src={node.imageUrl}
                        alt={node.name}
                        className="h-10 w-10 flex-shrink-0 rounded border border-gray-700 object-cover"
                      />
                    ) : (
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded border border-gray-700 bg-gray-800">
                        <span className="text-xs text-gray-600">NFT</span>
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-gray-200">{node.name}</p>
                      <p className="text-xs text-gray-500">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: getChainColor(node.chain) }}
                        />{' '}
                        {edge.sharedHolders.toLocaleString()} shared
                        {edge.holderDataReliable &&
                          ` · ${Math.round(edge.weight * 100)}% of smaller community`}
                      </p>
                    </div>
                    <div className="text-xs text-purple-400">→</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
