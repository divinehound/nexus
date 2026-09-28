'use client';

import { useState } from 'react';
import type { CashflowFlag, CashflowReport } from '@nexus/types';
import { addCashflowFlag, reimportCashflowFlags, removeCashflowFlag } from '@/lib/api';
import { truncateAddress } from '@/lib/utils';
import { useCashflowActions } from './actions';
import { CHAIN_LABELS, explorerName, relativeTime, txExplorerUrl } from './format';

/** EVM hashes are case-insensitive (the API stores them lowercased). */
export function flagKey(chain: string, txHash: string): string {
  return `${chain}:${chain === 'solana' ? txHash : txHash.toLowerCase()}`;
}

export function flagsByTx(report: CashflowReport): Map<string, CashflowFlag> {
  return new Map(report.flags.map((f) => [flagKey(f.chain, f.txHash), f]));
}

/** "This looks wrong" on one transaction, with an optional note of what's wrong. */
export function FlagControl({
  chain,
  txHash,
  flag,
}: {
  chain: string;
  txHash: string;
  flag: CashflowFlag | undefined;
}) {
  const { run, busy } = useCashflowActions();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(flag?.note ?? '');

  if (flag && !editing) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-3 text-yellow-400/90">
        <span>
          ⚑ Flagged{flag.note ? `: ${flag.note}` : ''}
          {flag.reimportedAt && (
            <span className="text-gray-500"> · re-imported {relativeTime(flag.reimportedAt)}</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-gray-400 hover:text-white"
        >
          Edit note
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run('Flag removed', (t, view) => removeCashflowFlag(t, flag.id, view))
          }
          className="text-gray-400 hover:text-white disabled:opacity-50"
        >
          Unflag (looks right now)
        </button>
      </div>
    );
  }
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="mt-2 text-gray-400 underline-offset-2 hover:text-yellow-300 hover:underline"
      >
        ⚑ Flag as wrong…
      </button>
    );
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run('Flagged — re-import flagged transactions once a fix is deployed', (t, view) =>
          addCashflowFlag(t, { chain, txHash, note: note || undefined }, view),
        ).then((ok) => ok && setEditing(false));
      }}
    >
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        placeholder="What's wrong? e.g. paid 0.3 ETH, shows free"
        className="min-w-64 flex-1 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-yellow-600/80 px-2 py-1 text-xs text-white hover:bg-yellow-600 disabled:opacity-50"
      >
        {flag ? 'Save' : 'Flag'}
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="text-gray-400 hover:text-white"
      >
        Cancel
      </button>
    </form>
  );
}

/**
 * Every flagged transaction, a way to flag one that's missing entirely (by
 * hash), and the button that re-reads just those transactions.
 */
export function FlagsPanel({ report, computing }: { report: CashflowReport; computing: boolean }) {
  const { run, busy } = useCashflowActions();
  const [open, setOpen] = useState(false);
  const [chain, setChain] = useState('ethereum');
  const [hash, setHash] = useState('');
  const [note, setNote] = useState('');
  const chains = [...new Set(report.walletChains.flatMap((w) => w.chains))];
  const flags = [...report.flags].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <section className="rounded-xl border border-gray-800 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="font-medium text-gray-200 hover:text-white"
        >
          ⚑ Flagged transactions ({flags.length}) {open ? '▾' : '▸'}
        </button>
        <span className="text-xs text-gray-500">
          Flag anything read wrong, then re-import just those once a fix is out — no full rescan.
        </span>
        {flags.length > 0 && (
          <button
            type="button"
            disabled={busy || computing}
            onClick={() =>
              void run('Re-importing flagged transactions…', (t, view) =>
                reimportCashflowFlags(t, view),
              )
            }
            className="ml-auto rounded-lg bg-yellow-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Re-import flagged ({flags.length})
          </button>
        )}
      </div>
      {open && (
        <div className="mt-3 space-y-3">
          {flags.length > 0 ? (
            <ul className="divide-y divide-gray-800/70 text-xs">
              {flags.map((f) => {
                const url = txExplorerUrl(f.chain, f.txHash);
                return (
                  <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="w-20 text-gray-400">{CHAIN_LABELS[f.chain] ?? f.chain}</span>
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-purple-300 hover:text-purple-200"
                        title={`View on ${explorerName(f.chain)}`}
                      >
                        {truncateAddress(f.txHash, 8)} ↗
                      </a>
                    ) : (
                      <span className="font-mono">{truncateAddress(f.txHash, 8)}</span>
                    )}
                    <span className="min-w-0 flex-1 text-gray-300">{f.note ?? ''}</span>
                    <span className="text-gray-500">
                      flagged {relativeTime(f.createdAt)}
                      {f.reimportedAt
                        ? ` · re-imported ${relativeTime(f.reimportedAt)}`
                        : ' · not re-imported yet'}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run('Flag removed', (t, view) => removeCashflowFlag(t, f.id, view))
                      }
                      className="text-gray-400 hover:text-white disabled:opacity-50"
                    >
                      Unflag
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-gray-500">
              Nothing flagged. Open <span className="text-gray-400">Details</span> on any activity
              row to flag it.
            </p>
          )}
          <form
            className="flex flex-wrap items-center gap-2 text-xs"
            onSubmit={(e) => {
              e.preventDefault();
              void run('Flagged', (t, view) =>
                addCashflowFlag(t, { chain, txHash: hash.trim(), note: note || undefined }, view),
              ).then((ok) => {
                if (ok) {
                  setHash('');
                  setNote('');
                }
              });
            }}
          >
            <span className="text-gray-400">Missing a transaction? Flag it by hash:</span>
            <select
              value={chain}
              onChange={(e) => setChain(e.target.value)}
              aria-label="Chain"
              className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-gray-200"
            >
              {chains.map((c) => (
                <option key={c} value={c}>
                  {CHAIN_LABELS[c] ?? c}
                </option>
              ))}
            </select>
            <input
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              placeholder="Transaction hash / signature"
              required
              minLength={10}
              className="min-w-64 flex-1 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 font-mono text-gray-200"
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="Note (optional)"
              className="min-w-40 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-gray-200"
            />
            <button
              type="submit"
              disabled={busy || !hash.trim()}
              className="rounded-md bg-gray-700 px-2 py-1 text-white hover:bg-gray-600 disabled:opacity-50"
            >
              Flag
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
