'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { getNetworkGraph, getCollectionConnections, type NetworkGraph, type NetworkGraphNode } from '@/lib/api';
import Link from 'next/link';
import * as d3 from 'd3';

interface NetworkGraphProps {
  strategy?: 'top-collections' | 'connected-traverse';
  maxNodes?: number;
  minSharedHolders?: number;
  chains?: string[];
  height?: number;
  initialFocusedNodeId?: string;
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

  const expandNode = useCallback(async (nodeId: string) => {
    if (expandedNodes.has(nodeId) || expandingNode === nodeId) return;

    setExpandingNode(nodeId);
    
    try {
      const { nodes: newNodes, edges: newEdges } = await getCollectionConnections(nodeId, {
        minSharedHolders,
        limit: 10,
      });

      setData(prevData => {
        if (!prevData) return { nodes: newNodes, edges: newEdges };

        const existingNodeIds = new Set(prevData.nodes.map(n => n.id));
        const nodesToAdd = newNodes.filter(n => !existingNodeIds.has(n.id));

        const existingEdgeKeys = new Set(
          prevData.edges.map(e => `${e.source}-${e.target}`)
        );
        const edgesToAdd = newEdges.filter(e => {
          const key = `${e.source}-${e.target}`;
          const reverseKey = `${e.target}-${e.source}`;
          return !existingEdgeKeys.has(key) && !existingEdgeKeys.has(reverseKey);
        });

        return {
          nodes: [...prevData.nodes, ...nodesToAdd],
          edges: [...prevData.edges, ...edgesToAdd],
        };
      });

      setExpandedNodes(prev => new Set([...prev, nodeId]));
    } catch (err) {
      console.error('Failed to expand node:', err);
    } finally {
      setExpandingNode(null);
    }
  }, [minSharedHolders, expandedNodes, expandingNode]);

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

    // Create force simulation
    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink<SimulationNode, SimulationLink>(links)
        .id(d => d.id)
        .distance(d => 150 - (d.weight * 100)) // Closer for stronger connections
        .strength(d => d.weight * 0.5)
      )
      .force('charge', d3.forceManyBody().strength(-800))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(d => Math.sqrt(d.holderCount || 0) / 3 + 20));

    simulationRef.current = simulation;

    // Draw edges
    const link = container.append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', '#4b5563')
      .attr('stroke-width', d => 1 + d.weight * 4)
      .attr('stroke-opacity', 0.6)
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
        if (focusedNode === d.id) {
          expandNode(d.id);
        } else {
          setFocusedNode(d.id);
        }
      })
      .on('mouseenter', (_event, d) => setHoveredNode(d.id))
      .on('mouseleave', () => setHoveredNode(null));

    // Add circles
    node.append('circle')
      .attr('r', d => Math.sqrt(d.holderCount || 0) / 3 + 12)
      .attr('fill', d => getChainColor(d.chain))
      .attr('stroke', d => expandedNodes.has(d.id) ? '#10b981' : '#1f2937')
      .attr('stroke-width', d => focusedNode === d.id ? 4 : 2)
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
  }, [data, focusedNode, expandedNodes, expandNode]);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-300">
            {data.nodes.length} Collections · {data.edges.length} Connections
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            Click to focus · Double-click to expand · Drag to reposition · Scroll to zoom
          </p>
        </div>
        {focusedNode && (
          <button
            onClick={() => setFocusedNode(null)}
            className="rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-600"
          >
            Reset Focus
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
        </div>
      )}
    </div>
  );
}
