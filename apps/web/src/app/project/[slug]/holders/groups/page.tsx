'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BUTTON, Pager, useAnalysis, WalletCell } from '@/components/holder-analysis/shared';
import { type Data, downloadCsv, holderAnalysis, num, type Paged, type Who } from '@/lib/holder-analysis';

const EVIDENCE: Record<string, string> = {
  shared_email: 'same email',
  delegation: 'delegations',
  operator: 'moved tokens for each other',
  mint_for: 'minted for each other',
  funded_by_holder: 'funded by a member',
  free_transfer: 'free transfers between them',
  shared_funder: 'same first funder',
  same_block: 'acted in the same blocks',
};

export default function GroupsPage() {
  const { slug, projectId, overview, token } = useAnalysis();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<(Paged<{ rank: number; data: Data }> & { who: Record<string, Who> }) | null>(null);
  const core = overview.collections.filter((c) => c.core);

  useEffect(() => {
    let stale = false;
    holderAnalysis
      .groups(projectId, page, token)
      .then((r) => !stale && setData(r))
      .catch((err) => !stale && toast.error(err instanceof Error ? err.message : 'Could not load the groups'));
    return () => {
      stale = true;
    };
  }, [projectId, page, token]);

  const csv = (path: string, name: string) => downloadCsv(projectId, path, `${slug}-${name}`, token).catch((e) => toast.error(e.message));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-gray-400">
          Wallets that are likely one person, from how they were funded, delegations, and moving tokens for each other. Open a wallet to see the evidence, or to mark two wallets as different people.
        </p>
        <span className="flex gap-2">
          <button className={BUTTON} onClick={() => csv('groups.csv', 'wallet-groups.csv')}>
            Groups CSV
          </button>
          <button className={BUTTON} onClick={() => csv('links.csv', 'wallet-links.csv')}>
            Evidence CSV
          </button>
        </span>
      </div>
      {data?.rows.map((g) => {
        const d = g.data;
        const members = String(d.members ?? '').split(' ').filter(Boolean);
        const why = String(d.evidence ?? '')
          .split(' ')
          .filter(Boolean)
          .map((p) => EVIDENCE[p.split(':')[0]] ?? p.split(':')[0]);
        return (
          <div key={g.rank} className="rounded-xl border border-gray-800 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-medium">
                {String(d.cluster)} · {num(d.wallets)} wallets
              </h3>
              <span className="text-sm tabular-nums text-gray-300">
                {num(d.total)} held{core.length > 1 ? ` (${core.map((c) => `${num(d[`${c.id}_held`] ?? 0)} ${c.name}`).join(', ')})` : ''}
              </span>
            </div>
            {why.length > 0 && <p className="mt-1 text-xs text-gray-500">Linked by {why.join(', ')}</p>}
            <ul className="mt-3 grid gap-1 text-sm md:grid-cols-2">
              {members.map((m) => (
                <li key={m}>
                  <WalletCell slug={slug} address={m} who={data.who[m]} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {data && <Pager page={data.page} perPage={data.perPage} total={data.total} shown={data.rows.length} onPage={setPage} />}
    </div>
  );
}
