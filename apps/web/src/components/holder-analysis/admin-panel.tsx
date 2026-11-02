'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { type AdminStatus, day, holderAnalysis, minute, num } from '@/lib/holder-analysis';
import { ImportOldApp } from './import-old-app';
import { BUTTON, INPUT, SELECT } from './shared';

type Draft = { shortId: string; standard: string; core: boolean; decimals: string; staking: string };

/**
 * The holder analysis switch for one project (off by default, to limit what's read from the
 * chain), how it treats each collection, and how far the sync has got.
 */
export function HolderAnalysisAdminPanel({ projectId, slug, token }: { projectId: string; slug: string; token: string }) {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);

  // `keep`: keep unsaved edits on every collection except the one just saved.
  const apply = useCallback((s: AdminStatus, keep?: { except?: string }) => {
    setStatus(s);
    setDrafts((prev) => {
      const fresh: Record<string, Draft> = Object.fromEntries(
        s.collections
          .filter((c) => c.settings)
          .map((c) => [
            c.collectionId,
            {
              shortId: c.settings!.shortId,
              standard: c.settings!.standard,
              core: c.settings!.core,
              decimals: String(c.settings!.decimals),
              staking: c.settings!.stakingContracts.join('\n'),
            },
          ]),
      );
      if (!keep) return fresh;
      const out = { ...fresh };
      for (const id of Object.keys(fresh)) if (id !== keep.except && prev[id]) out[id] = prev[id];
      return out;
    });
  }, []);

  const load = useCallback(() => {
    holderAnalysis
      .adminStatus(projectId, token)
      .then(apply)
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Could not load the holder analysis'));
  }, [projectId, token, apply]);

  useEffect(load, [load]);

  if (!status) return null;

  const run = async (key: string, fn: () => Promise<unknown>, ok: string | ((r: unknown) => string)) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'collections' in r) apply(r as AdminStatus, { except: key });
      toast.success(typeof ok === 'function' ? ok(r) : ok);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  };
  const set = (id: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const caughtUp = status.collections.filter((c) => c.sync.live).length;

  return (
    <section className="rounded-xl border border-gray-800 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Holder analysis</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-400">
            Reads every transfer of this project's collections and the wallets that hold them (Alchemy, ENS, OpenSea, Etherscan), then analyses holders daily. Off by default: turning it
            on starts reading the chain within 10 minutes. The report is for this project's owners and editors.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status.enabled && (
            <Link href={`/project/${slug}/holders`} className={BUTTON}>
              Open report
            </Link>
          )}
          <button
            className={status.enabled ? BUTTON : `${BUTTON} border-purple-600 text-purple-200`}
            disabled={busy === 'toggle'}
            onClick={() => run('toggle', () => holderAnalysis.adminSetEnabled(projectId, !status.enabled, token), status.enabled ? 'Holder analysis turned off' : 'Holder analysis turned on')}
          >
            {status.enabled ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </div>

      {status.enabled && (
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-gray-400">
          <span>
            {caughtUp} of {status.collections.length} collections caught up
          </span>
          <span>
            {num(status.wallets.read)} of {num(status.wallets.total)} wallets read · {num(status.wallets.delegations)} delegations · {num(status.wallets.named)} named
          </span>
          <button className="text-purple-300 hover:text-purple-200" disabled={busy === 'sync'} onClick={() => run('sync', () => holderAnalysis.adminSync(token), (r) => ((r as { queued?: boolean })?.queued ? 'Sync queued' : 'A sync is already queued or running'))}>
            Sync now
          </button>
          <button className="text-gray-400 hover:text-white" onClick={load}>
            Refresh
          </button>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {status.collections.map((c) => {
          const d = drafts[c.collectionId];
          return (
            <div key={c.collectionId} className="rounded-lg border border-gray-800 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="font-medium">
                  {c.name} <span className="text-xs font-normal text-gray-500">{c.chain}</span>
                </div>
                <div className="text-xs text-gray-400">
                  {!c.settings
                    ? 'Not analysed (Solana, or no type the analysis can read)'
                    : c.sync.error
                      ? <span className="text-red-400">Error {c.sync.errorAt ? minute(c.sync.errorAt) : ''}: {c.sync.error}</span>
                      : c.sync.live
                        ? `Caught up · ${num(c.sync.transfers)} transfers · block ${num(c.sync.lastBlock ?? 0)} · ${day(c.sync.syncedAt)}`
                        : c.sync.lastBlock
                          ? `Reading the history · block ${num(c.sync.lastBlock)} · ${num(c.sync.transfers)} transfers so far`
                          : status.enabled
                            ? 'Waiting for the first sync'
                            : ''}
                  {c.sync.transactionsPending > 0 && ` · ${num(c.sync.transactionsPending)} transactions to look up`}
                </div>
              </div>
              {d && (
                <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-gray-500">Short id (CSV columns)</span>
                    <input className={`${INPUT} w-32`} value={d.shortId} onChange={(e) => set(c.collectionId, { shortId: e.target.value })} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-gray-500">Standard</span>
                    <select className={SELECT} value={d.standard} onChange={(e) =>
                        set(c.collectionId, {
                          standard: e.target.value,
                          // A collection switched to ERC-20 starts from the usual 18 decimals, not the 0 of an NFT.
                          ...(e.target.value === 'erc20' && c.settings!.standard !== 'erc20' ? { decimals: '18' } : {}),
                        })
                      }>
                      <option value="erc721">ERC-721</option>
                      <option value="erc1155">ERC-1155</option>
                      <option value="erc20">ERC-20</option>
                    </select>
                  </label>
                  {d.standard === 'erc20' && (
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-gray-500">Decimals</span>
                      <input className={`${INPUT} w-20`} value={d.decimals} onChange={(e) => set(c.collectionId, { decimals: e.target.value })} />
                    </label>
                  )}
                  <label className="flex items-center gap-2 pb-2" title="Core collections make up a holder's total and decide who counts as a holder">
                    <input type="checkbox" checked={d.core} onChange={(e) => set(c.collectionId, { core: e.target.checked })} />
                    Core
                  </label>
                  {d.standard === 'erc721' && (
                    <label className="flex min-w-64 flex-1 flex-col gap-1">
                      <span className="text-xs text-gray-500">Staking contracts (one per line; staked tokens still count for the staker)</span>
                      <textarea className={`${INPUT} font-mono`} rows={1} value={d.staking} onChange={(e) => set(c.collectionId, { staking: e.target.value })} />
                    </label>
                  )}
                  <button
                    className={BUTTON}
                    disabled={busy === c.collectionId}
                    onClick={() => {
                      const before = c.settings!;
                      const decimals = Number(d.decimals);
                      if (d.standard === 'erc20' && (!d.decimals.trim() || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)) {
                        toast.error('Decimals must be a whole number from 0 to 36');
                        return;
                      }
                      if (
                        (d.standard !== before.standard || (d.standard === 'erc20' && decimals !== before.decimals)) &&
                        !window.confirm('Changing the standard or decimals reads this collection from the chain again. Carry on?')
                      )
                        return;
                      run(
                        c.collectionId,
                        () =>
                          holderAnalysis.adminSaveSettings(
                            c.collectionId,
                            {
                              shortId: d.shortId,
                              standard: d.standard,
                              core: d.core,
                              ...(d.standard === 'erc20' ? { decimals } : {}),
                              stakingContracts: d.standard === 'erc721' ? d.staking.split(/[\s,]+/).filter(Boolean) : [],
                            },
                            token,
                          ),
                        `${c.name} saved`,
                      );
                    }}
                  >
                    Save
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ImportOldApp projectId={projectId} token={token} onDone={load} />
    </section>
  );
}
