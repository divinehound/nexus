'use client';

import { useMemo, useState } from 'react';
import type { CashflowActivity, CashflowReport, CashflowTxType } from '@nexus/types';
import { addCashflowLink, removeCashflowLink } from '@/lib/api';
import { cn, truncateAddress } from '@/lib/utils';
import { useCashflowActions } from './actions';
import { CHAIN_LABELS, TX_TYPE_LABELS, pnlClass, txExplorerUrl, usd, usdSigned } from './format';

const ACTIVITY_FILTERS: Array<{ id: string; label: string; types: CashflowTxType[] | null }> = [
  { id: 'all', label: 'All', types: null },
  { id: 'buys', label: 'Buys & mints', types: ['nft_purchase', 'nft_mint', 'token_purchase'] },
  { id: 'sales', label: 'Sales', types: ['nft_sale', 'token_sale'] },
  {
    id: 'transfers',
    label: 'Transfers',
    types: [
      'transfer_in',
      'transfer_out',
      'sent_asset',
      'received_asset',
      'own_wallet_transfer',
      'bridge',
    ],
  },
  { id: 'exchanges', label: 'Exchanges', types: ['exchange_deposit', 'exchange_withdrawal'] },
  { id: 'swaps', label: 'Swaps', types: ['swap'] },
];
const PAGE = 50;

const OUTGOING: CashflowTxType[] = ['transfer_out', 'exchange_deposit'];
const INCOMING: CashflowTxType[] = ['transfer_in', 'exchange_withdrawal'];
const LINK_SOURCE_LABELS = {
  auto: 'Matched automatically',
  manual: 'Linked by you',
  relay: 'From Relay records',
} as const;

export function ActivityList({ report }: { report: CashflowReport }) {
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(PAGE);
  const [linking, setLinking] = useState<string | null>(null);
  const types = ACTIVITY_FILTERS.find((f) => f.id === filter)?.types;
  // "All" skips unsolicited airdrops (no money, no gas) — they're still under Transfers.
  const rows = types
    ? report.activity.filter((a) => types.includes(a.type))
    : report.activity.filter(
        (a) => !(a.type === 'received_asset' && a.inUsd === 0 && a.outUsd === 0),
      );

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Activity type">
        {ACTIVITY_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => {
              setFilter(f.id);
              setLimit(PAGE);
            }}
            className={cn(
              'rounded-lg px-3 py-1 text-xs transition-colors',
              filter === f.id
                ? 'bg-purple-500/15 text-purple-300'
                : 'text-gray-400 hover:bg-gray-800 hover:text-white',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <p className="mb-3 text-xs text-gray-500">
        Money that left one of your wallets and reappeared in another (a bridge, SimpleSwap, an
        exchange round-trip) can be linked so it isn&apos;t counted as spending.
      </p>
      <ul className="divide-y divide-gray-800/70">
        {rows.slice(0, limit).map((a) => {
          const key = `${a.chain}:${a.txHash}`;
          return (
            <li key={key} className="py-3">
              <ActivityRow
                a={a}
                report={report}
                onLink={() => setLinking(linking === key ? null : key)}
                linkOpen={linking === key}
              />
              {linking === key && (
                <LinkPicker source={a} report={report} onDone={() => setLinking(null)} />
              )}
            </li>
          );
        })}
      </ul>
      {rows.length > limit && (
        <button
          type="button"
          onClick={() => setLimit(limit + PAGE)}
          className="mt-3 text-xs text-gray-400 hover:text-white"
        >
          Show more ({rows.length - limit} remaining)
        </button>
      )}
      {rows.length === 0 && <p className="py-6 text-center text-sm text-gray-500">Nothing here.</p>}
    </div>
  );
}

function ActivityRow({
  a,
  report,
  onLink,
  linkOpen,
}: {
  a: CashflowActivity;
  report: CashflowReport;
  onLink: () => void;
  linkOpen: boolean;
}) {
  const { run, busy } = useCashflowActions();
  const url = txExplorerUrl(a.chain, a.txHash);
  const net = a.inUsd - a.outUsd;
  const linkable = OUTGOING.includes(a.type) || INCOMING.includes(a.type);

  const unlink = () => {
    if (!a.linkedTo) return;
    const pair =
      a.linkSide === 'out'
        ? {
            fromChain: a.chain,
            fromTxHash: a.txHash,
            toChain: a.linkedTo.chain,
            toTxHash: a.linkedTo.txHash,
          }
        : {
            fromChain: a.linkedTo.chain,
            fromTxHash: a.linkedTo.txHash,
            toChain: a.chain,
            toTxHash: a.txHash,
          };
    const manual = report.links.find(
      (l) =>
        l.kind === 'link' &&
        ((sameTx(l.fromChain, l.fromTxHash, pair.fromChain, pair.fromTxHash) &&
          sameTx(l.toChain, l.toTxHash, pair.toChain, pair.toTxHash)) ||
          (sameTx(l.fromChain, l.fromTxHash, pair.toChain, pair.toTxHash) &&
            sameTx(l.toChain, l.toTxHash, pair.fromChain, pair.fromTxHash))),
    );
    void run('Unlinked — counted as separate transfers again', (token) =>
      manual
        ? removeCashflowLink(token, manual.id)
        : addCashflowLink(token, { kind: 'unlink', ...pair }),
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <div className="w-24 shrink-0 text-xs text-gray-500">
        {new Date(a.timestamp).toLocaleDateString()}
        <div>{CHAIN_LABELS[a.chain] ?? a.chain}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-300">
            {TX_TYPE_LABELS[a.type]}
          </span>
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-sm text-gray-200 hover:text-purple-300"
            >
              {a.label}
            </a>
          ) : (
            <span className="truncate text-sm text-gray-200">{a.label}</span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
          {a.counterparty && <span className="font-mono">{truncateAddress(a.counterparty)}</span>}
          {a.linkSource && <span>{LINK_SOURCE_LABELS[a.linkSource]}</span>}
          {a.type === 'bridge' && (
            <button
              type="button"
              disabled={busy}
              onClick={unlink}
              className="text-gray-400 underline-offset-2 hover:text-white hover:underline disabled:opacity-50"
            >
              Unlink
            </button>
          )}
          {linkable && (
            <button
              type="button"
              onClick={onLink}
              aria-expanded={linkOpen}
              className="text-purple-300 underline-offset-2 hover:text-purple-200 hover:underline"
            >
              {linkOpen ? 'Cancel' : 'Link to my other wallet…'}
            </button>
          )}
        </div>
      </div>
      <div className="text-right text-sm tabular-nums">
        {(a.inUsd > 0 || a.outUsd > 0) && <div className={pnlClass(net)}>{usdSigned(net)}</div>}
        {a.realizedPnlUsd !== null && (
          <div className={cn('text-xs', pnlClass(a.realizedPnlUsd))}>
            P/L {usdSigned(a.realizedPnlUsd)}
          </div>
        )}
        {a.feeUsd > 0 && (
          <div className="text-xs text-gray-500">
            {a.type === 'bridge' ? 'fees' : 'gas'} {usd(a.feeUsd)}
          </div>
        )}
      </div>
    </div>
  );
}

function sameTx(chainA: string, hashA: string, chainB: string, hashB: string) {
  if (chainA !== chainB) return false;
  return chainA === 'solana' ? hashA === hashB : hashA.toLowerCase() === hashB.toLowerCase();
}

/** Money value of a transfer row, without the gas. */
const moneyOf = (a: CashflowActivity) =>
  OUTGOING.includes(a.type) ? a.outUsd - a.feeUsd : a.inUsd;

function LinkPicker({
  source,
  report,
  onDone,
}: {
  source: CashflowActivity;
  report: CashflowReport;
  onDone: () => void;
}) {
  const { run, busy } = useCashflowActions();
  const sourceIsOut = OUTGOING.includes(source.type);
  const [manualChain, setManualChain] = useState(source.chain === 'solana' ? 'ethereum' : 'solana');
  const [manualHash, setManualHash] = useState('');

  // Likely other halves: opposite direction, within a week, closest in value first.
  const candidates = useMemo(() => {
    const t0 = new Date(source.timestamp).getTime();
    const value = moneyOf(source);
    return report.activity
      .filter((b) => (sourceIsOut ? INCOMING : OUTGOING).includes(b.type) && b !== source)
      .map((b) => ({
        b,
        dt: new Date(b.timestamp).getTime() - t0,
        ratio: value > 0 ? moneyOf(b) / value : 0,
      }))
      .filter(({ dt }) =>
        sourceIsOut
          ? dt > -10 * 60_000 && dt < 7 * 86_400_000
          : dt < 10 * 60_000 && dt > -7 * 86_400_000,
      )
      .sort(
        (x, y) => Math.abs(1 - x.ratio) - Math.abs(1 - y.ratio) || Math.abs(x.dt) - Math.abs(y.dt),
      )
      .slice(0, 8);
  }, [report.activity, source, sourceIsOut]);

  const link = (chain: string, txHash: string) => {
    const pair = sourceIsOut
      ? { fromChain: source.chain, fromTxHash: source.txHash, toChain: chain, toTxHash: txHash }
      : { fromChain: chain, fromTxHash: txHash, toChain: source.chain, toTxHash: source.txHash };
    void run('Linked — counted as a move between your wallets', (token) =>
      addCashflowLink(token, { kind: 'link', ...pair }),
    ).then((ok) => ok && onDone());
  };

  return (
    <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900/40 p-3 text-sm">
      <div className="mb-2 text-xs text-gray-400">
        {sourceIsOut ? 'Where did this money arrive?' : 'Where did this money come from?'} Pick the
        matching transaction in your other wallet.
      </div>
      {candidates.length > 0 ? (
        <ul className="space-y-1">
          {candidates.map(({ b, dt }) => (
            <li key={`${b.chain}:${b.txHash}`}>
              <button
                type="button"
                disabled={busy}
                onClick={() => link(b.chain, b.txHash)}
                className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-gray-800 disabled:opacity-50"
              >
                <span className="min-w-0 truncate text-gray-200">
                  <span className="text-gray-500">{CHAIN_LABELS[b.chain] ?? b.chain} · </span>
                  {b.label}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-gray-400">
                  {usd(moneyOf(b))} · {formatGap(dt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-gray-500">No transfers in the week around this one.</p>
      )}
      <form
        className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-800 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (manualHash.trim()) link(manualChain, manualHash.trim());
        }}
      >
        <label className="text-xs text-gray-400" htmlFor={`link-chain-${source.txHash}`}>
          Or paste a transaction:
        </label>
        <select
          id={`link-chain-${source.txHash}`}
          value={manualChain}
          onChange={(e) => setManualChain(e.target.value)}
          className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
        >
          {Object.entries(CHAIN_LABELS).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <input
          value={manualHash}
          onChange={(e) => setManualHash(e.target.value)}
          placeholder="Transaction hash / signature"
          aria-label="Transaction hash or signature"
          className="min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 font-mono text-xs text-gray-200 placeholder:text-gray-600"
        />
        <button
          type="submit"
          disabled={busy || !manualHash.trim()}
          className="rounded-md bg-purple-600 px-3 py-1 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50"
        >
          Link
        </button>
      </form>
      <p className="mt-2 text-[11px] text-gray-500">
        A pasted transaction must be in one of your linked wallets. The difference between what left
        and what arrived is counted as a fee.
      </p>
    </div>
  );
}

function formatGap(ms: number): string {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? '−' : '+';
  if (abs < 3_600_000) return `${sign}${Math.round(abs / 60_000)} min`;
  if (abs < 86_400_000) return `${sign}${(abs / 3_600_000).toFixed(1)} h`;
  return `${sign}${(abs / 86_400_000).toFixed(1)} d`;
}
