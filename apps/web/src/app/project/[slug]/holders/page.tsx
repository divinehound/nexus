'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MonthlyLine } from '@/components/holder-analysis/line-chart';
import { BUTTON, INPUT, Pager, SELECT, StatusChip, Tile, useAnalysis, WalletCell } from '@/components/holder-analysis/shared';
import { day, downloadCsv, holderAnalysis, type HolderRow, num, type Paged, STATUS_LABEL, STATUS_ORDER } from '@/lib/holder-analysis';

const SHOWS: [string, string][] = [
  ['', 'Everyone'],
  ['labelled', 'Labelled'],
  ['new30', 'New in 30 days'],
  ['grouped', 'In a related group'],
  ['dormant', 'Dormant (any)'],
  ...STATUS_ORDER.map((s): [string, string] => [s, STATUS_LABEL[s]]),
];
const SORTS: [string, string][] = [
  ['size', 'Largest first'],
  ['newest', 'Newest holders'],
  ['oldest', 'Longest holding'],
  ['recent', 'Recently active'],
  ['idle', 'Longest idle'],
  ['in', 'Most in'],
  ['out', 'Most out'],
];

export default function HoldersPage() {
  const { slug, projectId, overview, token } = useAnalysis();
  const summary = overview.report?.summary;
  const core = overview.collections.filter((c) => c.core);
  const side = overview.collections.filter((c) => !c.core);
  const [view, setView] = useState('core');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [show, setShow] = useState('');
  const [sort, setSort] = useState('size');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Paged<HolderRow> | null>(null);

  useEffect(() => {
    if (!overview.report) return;
    let stale = false;
    const req =
      view === 'core' ? holderAnalysis.holders(projectId, { q: search, show, sort, page }, token) : holderAnalysis.side(projectId, view, page, token);
    req.then((r) => !stale && setRows(r)).catch((err) => toast.error(err instanceof Error ? err.message : 'Could not load holders'));
    return () => {
      stale = true;
    };
  }, [projectId, token, view, search, show, sort, page, overview.report]);

  if (!summary) return <p className="text-gray-400">The first report isn't ready yet.</p>;

  const status = summary.status_all ?? {};
  const dormant = Object.entries(status)
    .filter(([k]) => k.startsWith('dormant'))
    .reduce((a, [, n]) => a + n, 0);
  const csv = (path: string, name: string) => downloadCsv(projectId, path, `${slug}-${name}`, token).catch((e) => toast.error(e.message));
  const sideName = side.find((c) => c.collectionId === view)?.name;

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Holders" value={num(summary.holders_total)} sub={`${num(summary.holders_multi)} hold more than one`} />
        <Tile label="Active or quiet" value={num((status.active ?? 0) + (status.quiet ?? 0))} sub={`${num(status.parked ?? 0)} parked · ${num(dormant)} dormant`} />
        <Tile label="Related groups" value={num(summary.clusters?.count ?? 0)} sub={`${num(summary.clusters?.wallets ?? 0)} wallets likely one person`} />
        <Tile
          label="Last 30 days"
          value={`+${num(summary.activity?.d30?.new ?? 0)} / −${num(summary.activity?.d30?.exited ?? 0)}`}
          sub={`new / exited holders · ${num(summary.activity?.d30?.bought ?? 0)} buys`}
        />
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {core.map((c) => {
          const s = summary.collections?.[c.id];
          return s?.series ? (
            <MonthlyLine key={c.id} title={`${c.name}: holders by month`} unit="holders" points={s.series.map((p) => ({ month: p.month, value: p.holders }))} />
          ) : null;
        })}
      </section>

      <section>
        <div className="flex flex-wrap items-center gap-2">
          {side.length > 0 && (
            <select
              className={SELECT}
              value={view}
              onChange={(e) => {
                setView(e.target.value);
                setPage(1);
              }}
              aria-label="Collection"
            >
              <option value="core">{core.map((c) => c.name).join(' + ')}</option>
              {side.map((c) => (
                <option key={c.collectionId} value={c.collectionId}>
                  {c.name} (not in totals)
                </option>
              ))}
            </select>
          )}
          {view === 'core' && (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setSearch(q.trim());
                  setPage(1);
                }}
              >
                <input className={`${INPUT} w-64`} placeholder="Search wallet, ENS, OpenSea, label…" value={q} onChange={(e) => setQ(e.target.value)} />
              </form>
              <select className={SELECT} value={show} onChange={(e) => (setShow(e.target.value), setPage(1))} aria-label="Show">
                {SHOWS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <select className={SELECT} value={sort} onChange={(e) => (setSort(e.target.value), setPage(1))} aria-label="Sort">
                {SORTS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </>
          )}
          <span className="ml-auto flex gap-2">
            {view === 'core' ? (
              <button className={BUTTON} onClick={() => csv('holders.csv', 'holders.csv')}>
                Holders CSV
              </button>
            ) : (
              <button className={BUTTON} onClick={() => csv(`side/${view}/holders.csv`, `${sideName}-holders.csv`)}>
                {sideName} CSV
              </button>
            )}
          </span>
        </div>

        <div className="mt-3 overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Wallet</th>
                {view === 'core' ? (
                  <>
                    {core.map((c) => (
                      <th key={c.id} className="px-3 py-2 text-right">
                        {c.name}
                      </th>
                    ))}
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Holding since</th>
                    <th className="px-3 py-2">Group</th>
                  </>
                ) : (
                  <>
                    <th className="px-3 py-2 text-right">Held</th>
                    <th className="px-3 py-2 text-right">Core held</th>
                    <th className="px-3 py-2">Status</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows?.rows.map((r) => {
                const d = r.data;
                const sid = side.find((c) => c.collectionId === view)?.id ?? '';
                return (
                  <tr key={r.address} className="border-b border-gray-900 last:border-0">
                    <td className="px-3 py-2 tabular-nums text-gray-500">{r.rank}</td>
                    <td className="max-w-xs px-3 py-2">
                      <WalletCell slug={slug} address={r.address} who={r} />
                      {r.note && <div className="mt-0.5 truncate text-xs text-gray-500">{r.note}</div>}
                    </td>
                    {view === 'core' ? (
                      <>
                        {core.map((c) => {
                          const held = Number(d[`${c.id}_held`] ?? 0) + Number(d[`${c.id}_staked`] ?? 0);
                          return (
                            <td key={c.id} className="px-3 py-2 text-right tabular-nums">
                              {num(held)}
                              {Number(d[`${c.id}_staked`] ?? 0) > 0 && <span className="text-xs text-gray-500"> ({num(d[`${c.id}_staked`])} staked)</span>}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2">
                          <StatusChip status={String(d.status ?? '')} />
                        </td>
                        <td className="px-3 py-2 text-gray-400">{day(r.firstAt)}</td>
                        <td className="px-3 py-2 text-gray-400">{String(d.cluster ?? '')}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 text-right tabular-nums">{num(d[sid] ?? d.held ?? 0)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(d.core_total ?? 0)}</td>
                        <td className="px-3 py-2">
                          <StatusChip status={String(d.status ?? '')} />
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows && <Pager page={rows.page} perPage={rows.perPage} total={rows.total} shown={rows.rows.length} onPage={setPage} />}
      </section>
    </div>
  );
}
