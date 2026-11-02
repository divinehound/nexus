'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BUTTON, INPUT, Pager, StatusChip, Tile, useAnalysis, WalletCell } from '@/components/holder-analysis/shared';
import { useSetNickname } from '@/hooks/use-wallet-nicknames';
import {
  day,
  explorerAddress,
  explorerTx,
  holderAnalysis,
  KIND_LABEL,
  minute,
  num,
  openseaProfile,
  shortAddr,
  type WalletDetail,
} from '@/lib/holder-analysis';

const EVIDENCE: Record<string, string> = {
  shared_email: 'same email',
  delegation: 'delegation',
  operator: 'moved its tokens',
  mint_for: 'minted for it',
  funded_by_holder: 'funded it',
  free_transfer: 'free transfer between them',
  shared_funder: 'same first funder',
  same_block: 'acted in the same block',
};
const evidenceText = (e: string) =>
  e
    .split(' ')
    .filter(Boolean)
    .map((part) => {
      const [k, n] = part.split(':');
      return `${EVIDENCE[k] ?? k}${Number(n) > 1 ? ` ×${n}` : ''}`;
    })
    .join(', ');

export default function WalletPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: raw } = use(params);
  const address = raw.toLowerCase();
  const { slug, projectId, overview, token } = useAnalysis();
  const [w, setW] = useState<WalletDetail | null>(null);
  const [page, setPage] = useState(1);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [nick, setNick] = useState('');
  const [saving, setSaving] = useState(false);
  const { mutate: saveNickname } = useSetNickname();
  const byId = new Map(overview.collections.map((c) => [c.collectionId, c]));
  const chains = [...new Set(overview.collections.map((c) => c.chain))];

  const [error, setError] = useState('');
  const filled = useRef('');

  const load = useCallback(async () => {
    try {
      const d = await holderAnalysis.wallet(projectId, address, page, token);
      setW(d);
      setError('');
      // Fill the form once per wallet; paging the transfers keeps what's typed.
      if (filled.current !== address) {
        filled.current = address;
        setLabel(d.who?.label ?? '');
        setNote(d.who?.note ?? '');
        setNick(d.who?.nickname ?? '');
      }
      return d;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not load the wallet';
      setError(msg);
      toast.error(msg);
    }
  }, [projectId, address, page, token]);

  useEffect(() => {
    load();
  }, [load]);

  if (!w) {
    if (error) return <p className="text-sm text-gray-400">Could not load this wallet: {error}</p>;
    return <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />;
  }

  const d = w.holder?.data ?? {};
  const name = w.who?.ens || (w.who?.opensea ? `@${w.who.opensea}` : '');
  const main = w.profiles.find((p) => chains.includes(p.chain)) ?? w.profiles[0];
  const core = overview.collections.filter((c) => c.core);

  const saveLabel = async () => {
    setSaving(true);
    try {
      await holderAnalysis.saveLabel(projectId, address, { label, note }, token);
      toast.success(label || note ? "Saved for this project's admins" : 'Label removed');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };
  const unlink = async (other: string, remove = false) => {
    try {
      await holderAnalysis.unlink(projectId, { wallet: address, others: [other], remove }, token);
      toast.success(remove ? 'Mark removed: the groups are being redone' : 'Marked as different people: the groups are being redone');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    }
  };

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-2xl font-semibold">{w.who?.nickname || name || shortAddr(address)}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-400">
          <span className="font-mono">{address}</span>
          {name && w.who?.nickname && <span>{name}</span>}
          {w.who?.label && <span className="rounded bg-purple-900/50 px-1.5 py-0.5 text-xs text-purple-200">{w.who.label}</span>}
          <a href={openseaProfile(address)} target="_blank" rel="noreferrer" className="text-purple-300 hover:text-purple-200">
            OpenSea{w.who?.opensea ? ` (@${w.who.opensea})` : ''} ↗
          </a>
          {chains.map((c) => (
            <a key={c} href={explorerAddress(c, address)} target="_blank" rel="noreferrer" className="text-purple-300 hover:text-purple-200">
              {c === 'ethereum' ? 'Etherscan' : `${c[0].toUpperCase()}${c.slice(1)} explorer`} ↗
            </a>
          ))}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="Holds"
          value={w.holder ? num(d.total) : '0'}
          sub={w.holder ? `#${w.holder.rank} by size · ${core.map((c) => `${num(Number(d[`${c.id}_held`] ?? 0) + Number(d[`${c.id}_staked`] ?? 0))} ${c.name}`).join(' · ')}` : 'not a holder now'}
        />
        <Tile label="Status" value={w.holder ? <StatusChip status={String(d.status ?? '')} /> : '—'} sub={d.days_since_activity !== undefined && d.days_since_activity !== '' ? `${num(Math.round(Number(d.days_since_activity)))} days since activity` : undefined} />
        <Tile label="First got" value={<span className="text-lg">{String(d.first_acquired ?? '') || '—'}</span>} sub={d.last_acquired ? `last got ${d.last_acquired}` : undefined} />
        <Tile label="Outlook" value={<span className="text-lg">{String(d.outlook ?? '').replace(/_/g, ' ') || '—'}</span>} sub={d.last_other_tx ? `last outside transaction ${d.last_other_tx}` : undefined} />
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-medium text-gray-200">What we know</h3>
          <dl className="mt-3 space-y-2 text-sm">
            {main?.funder && (
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-gray-500">First funded by</dt>
                <dd>
                  <WalletCell slug={slug} address={main.funder} who={w.others[main.funder]} /> {main.fundedAt && <span className="text-gray-500">on {day(main.fundedAt)}</span>}
                </dd>
              </div>
            )}
            {main?.lastOutAt && (
              <div className="flex gap-x-2">
                <dt className="text-gray-500">Last outgoing activity</dt>
                <dd>{day(main.lastOutAt)}</dd>
              </div>
            )}
            {main?.isContract && (
              <div className="flex gap-x-2">
                <dt className="text-gray-500">Type</dt>
                <dd>Smart contract wallet</dd>
              </div>
            )}
            {w.profiles
              .flatMap((p) => p.delegations ?? [])
              .map((dl, i) => (
                <div key={i} className="flex flex-wrap gap-x-2">
                  <dt className="text-gray-500">Delegates to ({dl.src === 'warm' ? 'warm.xyz' : `delegate.xyz ${dl.src}`})</dt>
                  <dd>
                    <WalletCell slug={slug} address={dl.to.toLowerCase()} who={w.others[dl.to.toLowerCase()]} />
                  </dd>
                </div>
              ))}
            {!main && <p className="text-gray-500">The sync hasn't read this wallet yet.</p>}
          </dl>
        </div>

        <div className="space-y-4 rounded-xl border border-gray-800 p-4">
          <div>
            <h3 className="text-sm font-medium text-gray-200">Project label and note</h3>
            <p className="text-xs text-gray-500">Shared with this project's owners and editors.</p>
            <input className={`${INPUT} mt-2 w-full`} placeholder="Label" maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} />
            <textarea className={`${INPUT} mt-2 w-full`} rows={3} placeholder="Note" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
            <button className={`${BUTTON} mt-2`} onClick={saveLabel} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          <div>
            <h3 className="text-sm font-medium text-gray-200">Your nickname</h3>
            <p className="text-xs text-gray-500">Only you see it, everywhere in Nexus.</p>
            <div className="mt-2 flex gap-2">
              <input className={`${INPUT} flex-1`} placeholder="Nickname" maxLength={100} value={nick} onChange={(e) => setNick(e.target.value)} />
              <button
                className={BUTTON}
                onClick={() =>
                  saveNickname(
                    { address, nickname: nick.trim() || null },
                    { onSuccess: () => (toast.success('Nickname saved'), load()), onError: () => toast.error('Could not save the nickname') },
                  )
                }
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </section>

      {(w.groups.length > 0 || w.links.length > 0 || w.unlinked.length > 0) && (
        <section className="rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-medium text-gray-200">Related wallets</h3>
          {w.groups.map((g) => (
            <p key={g.rank} className="mt-2 text-sm text-gray-400">
              In group {String(g.data.cluster ?? g.rank)} with {num(Number(g.data.wallets ?? 0) - 1)} other wallets, holding {num(g.data.total ?? 0)} together.
            </p>
          ))}
          <table className="mt-3 w-full text-sm">
            <tbody>
              {w.links.map((l) => (
                <tr key={l.other} className="border-t border-gray-900">
                  <td className="py-2 pr-3">
                    <WalletCell slug={slug} address={l.other} who={w.others[l.other]} />
                  </td>
                  <td className="py-2 pr-3 text-gray-400">{evidenceText(l.evidence)}</td>
                  <td className="py-2 pr-3 tabular-nums text-gray-500">score {l.score}</td>
                  <td className="py-2 text-right">
                    <button className="text-xs text-gray-400 hover:text-white" onClick={() => unlink(l.other)}>
                      Not the same person
                    </button>
                  </td>
                </tr>
              ))}
              {w.unlinked.map((u) => (
                <tr key={u.other} className="border-t border-gray-900">
                  <td className="py-2 pr-3">
                    <WalletCell slug={slug} address={u.other} who={w.others[u.other]} />
                  </td>
                  <td className="py-2 pr-3 text-gray-500" colSpan={2}>
                    Marked as a different person on {day(u.at)}
                  </td>
                  <td className="py-2 text-right">
                    <button className="text-xs text-gray-400 hover:text-white" onClick={() => unlink(u.other, true)}>
                      Undo
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h3 className="text-sm font-medium text-gray-200">Transfers</h3>
        <div className="mt-3 overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2">When (UTC)</th>
                <th className="px-3 py-2">Collection</th>
                <th className="px-3 py-2">What</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Other side</th>
                <th className="px-3 py-2">Tx</th>
              </tr>
            </thead>
            <tbody>
              {w.transfers.rows.map((t) => {
                const c = byId.get(t.collectionId);
                const other = t.from === address ? t.to : t.from;
                const eth = t.txValueWei && t.txValueWei !== '0' ? Number(BigInt(t.txValueWei) / BigInt(1e12)) / 1e6 : 0;
                return (
                  <tr key={`${t.tx}-${t.logIndex}-${t.tokenId}-${t.from}-${t.to}`} className="border-b border-gray-900 last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 text-gray-400">{minute(t.at)}</td>
                    <td className="px-3 py-2">{c?.name ?? ''}</td>
                    <td className="px-3 py-2">
                      {KIND_LABEL[t.kind] ?? t.kind}
                      {eth > 0 && <span className="text-gray-500"> · {num(eth)} in the tx</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {num(t.amount)}
                      {t.tokenId && <span className="text-gray-500"> #{t.tokenId.length > 10 ? `${t.tokenId.slice(0, 8)}…` : t.tokenId}</span>}
                    </td>
                    <td className="px-3 py-2">{t.kind === 'self' ? '' : <WalletCell slug={slug} address={other} who={w.others[other]} />}</td>
                    <td className="px-3 py-2">
                      <a href={explorerTx(c?.chain ?? 'ethereum', t.tx)} target="_blank" rel="noreferrer" className="font-mono text-xs text-purple-300 hover:text-purple-200">
                        {t.tx.slice(0, 10)}↗
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager page={w.transfers.page} perPage={w.transfers.perPage} total={w.transfers.total} shown={w.transfers.rows.length} onPage={setPage} />
      </section>

      {w.funded.length > 0 && (
        <section>
          <h3 className="text-sm font-medium text-gray-200">Wallets it funded first</h3>
          <p className="text-xs text-gray-500">Wallets we follow whose first ETH came from this one.</p>
          <ul className="mt-2 grid gap-1 text-sm md:grid-cols-2">
            {w.funded.map((f) => (
              <li key={f.address} className="flex gap-2">
                <WalletCell slug={slug} address={f.address} who={w.others[f.address]} />
                <span className="text-gray-500">{day(f.fundedAt)}</span>
                {f.holderRank && <span className="text-gray-500">· holder #{f.holderRank}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
