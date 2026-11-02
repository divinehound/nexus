import { useState } from 'react';

/**
 * One series over months, as a 2px line with a crosshair and tooltip. The title names the
 * series, so there's no legend; the latest value is labelled directly.
 */
export function MonthlyLine({ title, points, unit }: { title: string; points: { month: string; value: number }[]; unit: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return null;
  const W = 640;
  const H = 180;
  const pad = { l: 44, r: 56, t: 12, b: 24 };
  const max = Math.max(1, ...points.map((p) => p.value));
  const x = (i: number) => pad.l + (i / (points.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const ticks = [0, max / 2, max];
  const years = points.map((p, i) => [p.month, i] as const).filter(([m], i) => i === 0 || m.endsWith('-01'));
  const last = points[points.length - 1];
  const h = hover == null ? null : points[hover];

  return (
    <figure className="rounded-xl border border-gray-800 p-4">
      <figcaption className="text-sm font-medium text-gray-200">{title}</figcaption>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="mt-2 h-auto w-full"
          role="img"
          aria-label={`${title}: ${last.value.toLocaleString()} ${unit} in ${last.month}`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * W;
            const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (points.length - 1));
            setHover(Math.max(0, Math.min(points.length - 1, i)));
          }}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="rgb(55 65 81)" strokeWidth={1} strokeDasharray={t ? '2 4' : undefined} />
              <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="fill-gray-500" fontSize={11}>
                {Math.round(t).toLocaleString()}
              </text>
            </g>
          ))}
          {years.map(([m, i]) => (
            <text key={m} x={x(i)} y={H - 6} textAnchor="middle" className="fill-gray-500" fontSize={11}>
              {m.slice(0, 4)}
            </text>
          ))}
          <path d={path} fill="none" stroke="rgb(168 85 247)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <text x={x(points.length - 1) + 6} y={y(last.value) + 4} className="fill-gray-300" fontSize={12}>
            {last.value.toLocaleString()}
          </text>
          {h && hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="rgb(107 114 128)" strokeWidth={1} />
              <circle cx={x(hover)} cy={y(h.value)} r={4} fill="rgb(168 85 247)" stroke="rgb(3 7 18)" strokeWidth={2} />
            </g>
          )}
        </svg>
        {h && hover != null && (
          <div
            className="pointer-events-none absolute top-0 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200 shadow"
            style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > points.length / 2 ? '-110%' : '10%'})` }}
          >
            <div className="text-gray-400">{h.month}</div>
            <div className="tabular-nums">
              {h.value.toLocaleString()} {unit}
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}
