'use client';

import { useEffect, useRef, useState } from 'react';
import { getNetworkGraph, type NetworkGraph } from '@/lib/api';
import Link from 'next/link';

interface NetworkGraphProps {
  maxNodes?: number;
  minSharedHolders?: number;
  chains?: string[];
  height?: number;
}

export function NetworkGraphVisualization({
  maxNodes = 50,
  minSharedHolders = 5,
  chains,
  height = 600,
}: NetworkGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [data, setData] = useState<NetworkGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, [maxNodes, minSharedHolders, chains]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const graph = await getNetworkGraph({ maxNodes, minSharedHolders, chains });
      setData(graph);
    } catch (err: any) {
      setError(err.message || 'Failed to load network graph');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!data || !svgRef.current) return;

    const svg = svgRef.current;
    const width = svg.clientWidth;
    const height = svg.clientHeight;

    // Simple force-directed layout simulation
    const nodes = data.nodes.map((n, i) => ({
      ...n,
      x: width / 2 + (Math.random() - 0.5) * width * 0.8,
      y: height / 2 + (Math.random() - 0.5) * height * 0.8,
      vx: 0,
      vy: 0,
    }));

    const edges = data.edges;

    // Physics simulation
    const simulate = () => {
      const alpha = 0.3;
      const centerForce = 0.01;
      const repelForce = 2000;
      const attractForce = 0.05;

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
        node.vx *= 0.8;
        node.vy *= 0.8;

        // Keep in bounds
        node.x = Math.max(30, Math.min(width - 30, node.x));
        node.y = Math.max(30, Math.min(height - 30, node.y));
      });
    };

    // Run simulation
    const iterations = 100;
    for (let i = 0; i < iterations; i++) {
      simulate();
    }

    // Render
    const g = svg.querySelector('g');
    if (!g) return;

    // Clear previous
    g.innerHTML = '';

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

      // Node circle
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', node.x.toString());
      circle.setAttribute('cy', node.y.toString());
      const radius = Math.sqrt(node.holderCount) / 3 + 8;
      circle.setAttribute('r', radius.toString());
      circle.setAttribute('fill', '#8b5cf6');
      circle.setAttribute('stroke', '#a78bfa');
      circle.setAttribute('stroke-width', '2');
      nodeG.appendChild(circle);

      // Node label
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', node.x.toString());
      text.setAttribute('y', (node.y + radius + 12).toString());
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', '#d1d5db');
      text.setAttribute('font-size', '10');
      text.textContent = node.name.length > 20 ? node.name.slice(0, 18) + '...' : node.name;
      nodeG.appendChild(text);

      // Hover events
      nodeG.addEventListener('mouseenter', () => setHoveredNode(node.id));
      nodeG.addEventListener('mouseleave', () => setHoveredNode(null));
      nodeG.addEventListener('click', () => setSelectedNode(node.id));

      g.appendChild(nodeG);
    });
  }, [data]);

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

  const selectedNodeData = selectedNode ? data.nodes.find((n) => n.id === selectedNode) : null;
  const connectedEdges = selectedNode
    ? data.edges.filter((e) => e.source === selectedNode || e.target === selectedNode)
    : [];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-100">Collection Network</h3>
            <p className="text-sm text-gray-400">
              {data.nodes.length} collections • {data.edges.length} connections
            </p>
          </div>
          {selectedNode && (
            <button
              onClick={() => setSelectedNode(null)}
              className="rounded bg-gray-800 px-3 py-1 text-sm text-gray-300 hover:bg-gray-700"
            >
              Clear Selection
            </button>
          )}
        </div>
        <svg
          ref={svgRef}
          className="w-full rounded-lg bg-gray-950"
          style={{ height: `${height}px` }}
          viewBox={`0 0 1000 ${height}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <g />
        </svg>
      </div>

      {selectedNodeData && (
        <div className="rounded-xl border border-purple-900/50 bg-purple-950/30 p-4">
          <div className="flex items-start gap-3">
            {selectedNodeData.imageUrl && (
              <img
                src={selectedNodeData.imageUrl}
                alt={selectedNodeData.name}
                className="h-16 w-16 rounded-lg border border-gray-700 object-cover"
              />
            )}
            <div className="flex-1">
              <h4 className="font-medium text-gray-100">{selectedNodeData.name}</h4>
              <p className="text-sm text-gray-400">
                {selectedNodeData.chain} • {selectedNodeData.holderCount.toLocaleString()} holders
              </p>
              <p className="mt-2 text-xs text-gray-500">
                Connected to {connectedEdges.length} other collection
                {connectedEdges.length !== 1 ? 's' : ''}
              </p>
            </div>
            <Link
              href={`/collection/${selectedNodeData.chain}/${selectedNodeData.contractAddress}`}
              className="rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-600"
            >
              View
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
