'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { chainCurrency } from '@nexus/types';
import { Pager, SELECT, useAnalysis, WalletCell } from '@/components/holder-analysis/shared';
import { type ActivityRow, explorerTx, holderAnalysis, KIND_LABEL, minute, num, type Paged } from '@/lib/holder-analysis';

const FEED: [string, string][] = [
  ['', 'Everything'],
  ['new', 'New holders'],
  ['returned', 'Came back'],
  ['exited', 'Exited'],
  ['bought', 'Bought'],
  ['sold', 'Sold'],
  ['minted', 'Minted'],
  ['received', 'Received'],
  ['sent', 'Sent'],
  ['burned', 'Burned'],
];
const FLAG: Record<string, string> = { new: 'new holder', returned: 'came back', exited: 'exited' };

export default function ActivityPage() {
  const { slug, projectId, overview, token } = useAnalysis();
  const core = overview.collections.filter((c) => c.core);
  const byId = new Map(overview.collections.map((c) => [c.collectionId, c]));
  const [kind, setKind] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [labelled, setLabelled] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<ActivityRow> | null>(null);

  useEffect(() => {
    holderAnalysis
      .activity(projectId, { kind, collectionId, labelled: labelled ? '1' : '', page }, token)
      .then(setData)
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Could not load the activity'));
  }, [projectId, token, kind, collectionId, labelled, page]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={SELECT} value={kind} onChange={(e) => (setKind(e.target.value), setPage(1))} aria-label="What happened">
          {FEED.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {core.length > 1 && (
          <select className={SELECT} value={collectionId} onChange={(e) => (setCollectionId(e.target.value), setPage(1))} aria-label="Collection">
            <option value="">All collections</option>
            {core.map((c) => (
              <option key={c.collectionId} value={c.collectionId}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={labelled} onChange={(e) => (setLabelled(e.target.checked), setPage(1))} />
          Labelled wallets only
        </label>
        <span className="ml-auto text-xs text-gray-500">The last year, as of the latest analysis.</span>
      </div>
      <div className="mt-3 overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2">When (UTC)</th>
              <th className="px-3 py-2">Wallet</th>
              <th className="px-3 py-2">What</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Tx</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((a) => {
              const c = byId.get(a.collectionId);
              return (
                <tr key={`${a.tx}-${a.address}-${a.collectionId}-${a.kind}`} className="border-b border-gray-900 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-gray-400">{minute(a.at)}</td>
                  <td className="max-w-xs px-3 py-2">
                    <WalletCell slug={slug} address={a.address} who={a} />
                  </td>
                  <td className="px-3 py-2">
                    {KIND_LABEL[a.kind] ?? a.kind}
                    {a.eth > 0 && <span className="text-gray-500"> for {num(a.eth)} {chainCurrency(c?.chain ?? 'ethereum')}</span>}
                    {a.flag && <span className="ml-2 rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">{FLAG[a.flag] ?? a.flag}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {num(a.amount)} {core.length > 1 ? c?.name : ''}
                  </td>
                  <td className="px-3 py-2">
                    <a href={explorerTx(c?.chain ?? 'ethereum', a.tx)} target="_blank" rel="noreferrer" className="font-mono text-xs text-purple-300 hover:text-purple-200">
                      {a.tx.slice(0, 10)}↗
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data && <Pager page={data.page} perPage={data.perPage} total={data.total} shown={data.rows.length} onPage={setPage} />}
    </div>
  );
}
