'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';

interface BalanceEntry {
  blockTimestamp: string;
  direction: 'in' | 'out';
  balanceAfter: number;
  tokenId: string;
  transactionHash: string;
  counterpartyAddress: string | null;
}

interface DayPoint {
  date: Date;
  dateStr: string;
  balanceAfter: number;
  inCount: number;
  outCount: number;
  netChange: number;
  entries: BalanceEntry[];
}

interface TooltipData {
  x: number;
  y: number;
  point: DayPoint;
}

interface BalanceLineChartProps {
  entries: BalanceEntry[];
  xDomain: [Date, Date];
}

const MARGIN = { top: 16, right: 24, bottom: 32, left: 48 };
const HEIGHT = 180;

const DOT_COLOR_IN = '#60a5fa';
const DOT_COLOR_OUT = '#fb923c';
const DOT_COLOR_BOTH = '#c084fc';
const LINE_COLOR = '#c084fc';
const AREA_COLOR = 'rgba(88, 28, 135, 0.25)';

function groupByDay(entries: BalanceEntry[]): DayPoint[] {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.blockTimestamp).getTime() - new Date(b.blockTimestamp).getTime(),
  );

  const dayMap = new Map<string, { entries: BalanceEntry[]; date: Date }>();

  for (const entry of sorted) {
    const d = new Date(entry.blockTimestamp);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!dayMap.has(key)) {
      dayMap.set(key, { entries: [], date: new Date(d.getFullYear(), d.getMonth(), d.getDate()) });
    }
    dayMap.get(key)!.entries.push(entry);
  }

  const points: DayPoint[] = [];
  for (const [dateStr, { entries: dayEntries, date }] of dayMap) {
    const inCount = dayEntries.filter((e) => e.direction === 'in').length;
    const outCount = dayEntries.filter((e) => e.direction === 'out').length;
    const balanceAfter = dayEntries[dayEntries.length - 1].balanceAfter;

    const firstBalance = dayEntries.length > 0
      ? (points.length > 0 ? points[points.length - 1].balanceAfter : 0)
      : 0;
    const netChange = balanceAfter - firstBalance;

    points.push({ date, dateStr, balanceAfter, inCount, outCount, netChange, entries: dayEntries });
  }

  return points;
}

function dotColor(point: DayPoint): string {
  if (point.inCount > 0 && point.outCount > 0) return DOT_COLOR_BOTH;
  if (point.outCount > 0) return DOT_COLOR_OUT;
  return DOT_COLOR_IN;
}

export default function BalanceLineChart({ entries, xDomain }: BalanceLineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(600);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  const dayPoints = useMemo(() => groupByDay(entries), [entries]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((obs) => {
      const entry = obs[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!svgRef.current || dayPoints.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const innerW = width - MARGIN.left - MARGIN.right;
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

    const x = d3.scaleTime().domain(xDomain).range([0, innerW]);
    const localYMax = Math.max(1, d3.max(dayPoints, (d) => d.balanceAfter) ?? 1);
    const y = d3.scaleLinear().domain([0, localYMax]).nice().range([innerH, 0]);

    const g = svg
      .attr('width', width)
      .attr('height', HEIGHT)
      .append('g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(
        d3.axisBottom(x).ticks(5).tickSize(-innerH).tickFormat((d) => d3.timeFormat('%b %d')(d as Date)),
      )
      .call((g) => g.select('.domain').remove())
      .call((g) => g.selectAll('.tick line').attr('stroke', '#374151').attr('stroke-dasharray', '2,2'))
      .call((g) => g.selectAll('.tick text').attr('fill', '#6b7280').attr('font-size', '10px'));

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickSize(-innerW))
      .call((g) => g.select('.domain').remove())
      .call((g) => g.selectAll('.tick line').attr('stroke', '#374151').attr('stroke-dasharray', '2,2'))
      .call((g) => g.selectAll('.tick text').attr('fill', '#6b7280').attr('font-size', '10px'));

    // Extend line/area to the end of the time domain (last scanned date)
    const lastPoint = dayPoints[dayPoints.length - 1];
    const trailDate = xDomain[1];
    const linePoints: DayPoint[] =
      lastPoint && trailDate > lastPoint.date
        ? [...dayPoints, { ...lastPoint, date: trailDate, entries: [] }]
        : dayPoints;

    // Area
    const area = d3
      .area<DayPoint>()
      .x((d) => x(d.date))
      .y0(innerH)
      .y1((d) => y(d.balanceAfter))
      .curve(d3.curveStepAfter);

    g.append('path').datum(linePoints).attr('d', area).attr('fill', AREA_COLOR);

    // Line
    const line = d3
      .line<DayPoint>()
      .x((d) => x(d.date))
      .y((d) => y(d.balanceAfter))
      .curve(d3.curveStepAfter);

    g.append('path')
      .datum(linePoints)
      .attr('d', line)
      .attr('fill', 'none')
      .attr('stroke', LINE_COLOR)
      .attr('stroke-width', 2);

    // Dots
    g.selectAll('.dot')
      .data(dayPoints)
      .enter()
      .append('circle')
      .attr('cx', (d) => x(d.date))
      .attr('cy', (d) => y(d.balanceAfter))
      .attr('r', 4)
      .attr('fill', (d) => dotColor(d))
      .attr('stroke', '#111827')
      .attr('stroke-width', 1.5)
      .attr('cursor', 'pointer')
      .on('mouseenter', function (event, d) {
        d3.select(this).transition().duration(100).attr('r', 6);
        const cx = x(d.date) + MARGIN.left;
        const cy = y(d.balanceAfter) + MARGIN.top;
        setTooltip({ x: cx, y: cy, point: d });
      })
      .on('mouseleave', function () {
        d3.select(this).transition().duration(100).attr('r', 4);
        setTooltip(null);
      });
  }, [dayPoints, width, xDomain]);

  if (entries.length === 0) {
    return <div className="py-4 text-center text-xs text-gray-500">No balance history for this wallet.</div>;
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <svg ref={svgRef} width={width} height={HEIGHT} />
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-gray-700 bg-gray-900 p-2 text-xs shadow-lg"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, -100%) translateY(-10px)',
          }}
        >
          <div className="font-medium text-white">{tooltip.point.dateStr}</div>
          <div className="mt-1 flex gap-3">
            {tooltip.point.inCount > 0 && (
              <span style={{ color: DOT_COLOR_IN }}>{tooltip.point.inCount} IN</span>
            )}
            {tooltip.point.outCount > 0 && (
              <span style={{ color: DOT_COLOR_OUT }}>{tooltip.point.outCount} OUT</span>
            )}
          </div>
          <div className="mt-1 text-gray-400">
            Net: <span className={tooltip.point.netChange >= 0 ? 'text-blue-400' : 'text-orange-400'}>{tooltip.point.netChange >= 0 ? '+' : ''}{tooltip.point.netChange}</span>
          </div>
          <div className="text-gray-400">
            Balance: <span className="text-white">{tooltip.point.balanceAfter}</span>
          </div>
        </div>
      )}
    </div>
  );
}
