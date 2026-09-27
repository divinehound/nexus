'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { CashflowMonth } from '@nexus/types';
import {
  CATEGORY_LABELS,
  IN_CATEGORIES,
  OUT_CATEGORIES,
  monthLabel,
  usd,
  usdShort,
  usdSigned,
} from './format';

// Categorical slots 1–2 of the validated dark palette (checked against the gray-950 surface).
export const IN_COLOR = '#3987e5';
export const OUT_COLOR = '#d95926';

const HEIGHT = 280;
const MARGIN = { top: 12, right: 12, bottom: 28, left: 56 };
const RADIUS = 4;

/**
 * Bar whose data end (away from the zero line) is rounded and whose baseline
 * end is square, so every bar reads as anchored to zero.
 */
function barPath(x: number, w: number, yZero: number, yEnd: number): string {
  const h = Math.abs(yEnd - yZero);
  if (h < 0.5) return '';
  const r = Math.min(RADIUS, w / 2, h);
  if (yEnd < yZero) {
    // grows upward
    return `M${x},${yZero}V${yEnd + r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd + r}V${yZero}Z`;
  }
  return `M${x},${yZero}V${yEnd - r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd - r}V${yZero}Z`;
}

export function CashflowChart({ months }: { months: CashflowMonth[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geometry = useMemo(() => {
    if (width === 0 || months.length === 0) return null;
    const innerW = width - MARGIN.left - MARGIN.right;
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
    const x = d3
      .scaleBand<string>()
      .domain(months.map((m) => m.month))
      .range([0, innerW])
      .paddingInner(0.25)
      .paddingOuter(0.1);
    const maxIn = d3.max(months, (m) => m.inUsd) ?? 0;
    const maxOut = d3.max(months, (m) => m.outUsd) ?? 0;
    const y = d3
      .scaleLinear()
      .domain([-(maxOut || 1), maxIn || 1])
      .range([innerH, 0])
      .nice(5);
    // Thin the x labels so they never collide (~56px per label).
    const every = Math.max(1, Math.ceil((56 * months.length) / innerW));
    return { innerW, innerH, x, y, every };
  }, [months, width]);

  const hovered = hover !== null ? months[hover] : null;

  return (
    <div>
      <div
        className="mb-3 flex flex-wrap items-center gap-4 text-xs text-gray-400"
        aria-hidden="true"
      >
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: IN_COLOR }} />{' '}
          Money in (above the line)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: OUT_COLOR }} />{' '}
          Money out incl. gas (below the line)
        </span>
      </div>
      <div ref={containerRef} className="relative w-full" onMouseLeave={() => setHover(null)}>
        {geometry && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label="Monthly money in versus money out"
          >
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              {geometry.y.ticks(5).map((t) => (
                <g key={t}>
                  <line
                    x1={0}
                    x2={geometry.innerW}
                    y1={geometry.y(t)}
                    y2={geometry.y(t)}
                    stroke={t === 0 ? '#6b7280' : '#1f2937'}
                    strokeWidth={1}
                  />
                  <text
                    x={-8}
                    y={geometry.y(t)}
                    dy="0.32em"
                    textAnchor="end"
                    className="fill-gray-500"
                    fontSize={11}
                  >
                    {usdShort(Math.abs(t))}
                  </text>
                </g>
              ))}
              {months.map((m, i) => {
                const bx = geometry.x(m.month) ?? 0;
                const bw = geometry.x.bandwidth();
                const y0 = geometry.y(0);
                const active = hover === i;
                return (
                  <g key={m.month} opacity={hover === null || active ? 1 : 0.45}>
                    <path d={barPath(bx, bw, y0 - 1, geometry.y(m.inUsd))} fill={IN_COLOR} />
                    <path d={barPath(bx, bw, y0 + 1, geometry.y(-m.outUsd))} fill={OUT_COLOR} />
                    {i % geometry.every === 0 && (
                      <text
                        x={bx + bw / 2}
                        y={geometry.innerH + 18}
                        textAnchor="middle"
                        className="fill-gray-500"
                        fontSize={11}
                      >
                        {monthLabel(m.month)}
                      </text>
                    )}
                    {/* Hit target: the whole column, larger than the bars. */}
                    <rect
                      x={bx - (geometry.x.step() - bw) / 2}
                      y={0}
                      width={geometry.x.step()}
                      height={geometry.innerH}
                      fill="transparent"
                      onMouseEnter={() => setHover(i)}
                      onFocus={() => setHover(i)}
                      tabIndex={0}
                      aria-label={`${monthLabel(m.month, 'long')}: in ${usd(m.inUsd)}, out ${usd(m.outUsd)}`}
                    />
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        {geometry && hovered && hover !== null && (
          <MonthTooltip
            month={hovered}
            columnLeft={MARGIN.left + (geometry.x(hovered.month) ?? 0)}
            columnWidth={geometry.x.bandwidth()}
            containerWidth={width}
          />
        )}
      </div>
    </div>
  );
}

function MonthTooltip({
  month,
  columnLeft,
  columnWidth,
  containerWidth,
}: {
  month: CashflowMonth;
  columnLeft: number;
  columnWidth: number;
  containerWidth: number;
}) {
  const W = 240;
  const GAP = 12;
  // Sit beside the hovered column (right side in the left half, left side in the right half) so it never hides the bars.
  const preferred =
    columnLeft + columnWidth / 2 < containerWidth / 2
      ? columnLeft + columnWidth + GAP
      : columnLeft - W - GAP;
  const clamped = Math.min(Math.max(preferred, 0), Math.max(containerWidth - W, 0));
  const rows = (cats: typeof OUT_CATEGORIES) =>
    cats
      .filter((c) => (month.byCategory[c] ?? 0) > 0)
      .map((c) => (
        <div key={c} className="flex justify-between gap-3 text-gray-400">
          <span>{CATEGORY_LABELS[c]}</span>
          <span className="tabular-nums text-gray-200">{usd(month.byCategory[c] ?? 0)}</span>
        </div>
      ));
  const net = month.inUsd - month.outUsd;
  return (
    <div
      className="pointer-events-none absolute top-2 z-10 rounded-lg border border-gray-700 bg-gray-900/95 p-3 text-xs shadow-xl"
      style={{ left: clamped, width: W }}
    >
      <div className="mb-2 font-semibold text-white">{monthLabel(month.month, 'long')}</div>
      <div className="flex justify-between font-medium">
        <span className="flex items-center gap-1.5 text-gray-300">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: IN_COLOR }} /> In
        </span>
        <span className="tabular-nums text-white">{usd(month.inUsd)}</span>
      </div>
      <div className="mb-1 pl-3.5">{rows(IN_CATEGORIES)}</div>
      <div className="flex justify-between font-medium">
        <span className="flex items-center gap-1.5 text-gray-300">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: OUT_COLOR }} /> Out
        </span>
        <span className="tabular-nums text-white">{usd(month.outUsd)}</span>
      </div>
      <div className="mb-2 pl-3.5">{rows(OUT_CATEGORIES)}</div>
      <div className="flex justify-between border-t border-gray-700 pt-2 text-gray-300">
        <span>Net</span>
        <span className="tabular-nums text-white">{usdSigned(net)}</span>
      </div>
      <div className="flex justify-between text-gray-300">
        <span>Realized P/L</span>
        <span className="tabular-nums text-white">{usdSigned(month.realizedPnlUsd)}</span>
      </div>
      <div className="flex justify-between text-gray-400">
        <span>after gas</span>
        <span className="tabular-nums text-gray-200">
          {usdSigned(month.realizedPnlAfterGasUsd)}
        </span>
      </div>
    </div>
  );
}
