'use client';

import { useMemo, useState } from 'react';
import type { CashflowPosition, CashflowTokenTrade, CashflowTokenTradeKind } from '@nexus/types';
import { cn } from '@/lib/utils';
import { explorerName, qty, txExplorerUrl, usd } from './format';
import { Dual } from './ui';

const KIND_LABELS: Record<CashflowTokenTradeKind, string> = {
  buy: 'Bought',
  sell: 'Sold',
  received: 'Received',
  sent: 'Sent away',
  burned: 'Burned',
  swap_in: 'Swapped in',
  swap_out: 'Swapped out',
};
const KIND_CLASS: Partial<Record<CashflowTokenTradeKind, string>> = {
  buy: 'text-orange-300',
  sell: 'text-sky-300',
};

type Filter = 'all' | 'buys' | 'sales' | 'other';
const FILTERS: Array<{ id: Filter; label: string; match: (t: CashflowTokenTrade) => boolean }> = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'buys', label: 'Buys', match: (t) => t.kind === 'buy' || t.kind === 'swap_in' },
  { id: 'sales', label: 'Sales', match: (t) => t.kind === 'sell' || t.kind === 'swap_out' },
  {
    id: 'other',
    label: 'Transfers',
    match: (t) => t.kind === 'received' || t.kind === 'sent' || t.kind === 'burned',
  },
];
const PAGE = 50;

/** Every buy, sale and move of one token, newest first — the token counterpart of the NFT item list. */
export function TokenTradesTable({ position }: { position: CashflowPosition }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest');
  const [limit, setLimit] = useState(PAGE);
  const unit = position.symbol ?? position.name;
  const sym = position.nativeSymbol;

  const rows = useMemo(() => {
    const match = FILTERS.find((f) => f.id === filter)!.match;
    const list = position.trades.filter(match);
    // The API sends newest first.
    return order === 'newest' ? list : [...list].reverse();
  }, [position.trades, filter, order]);

  return (
    <div className="mt-1 rounded-lg border border-gray-800 bg-gray-900/40 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => {
              setFilter(f.id);
              setLimit(PAGE);
            }}
            className={cn(
              'rounded-md px-2 py-0.5',
              filter === f.id
                ? 'bg-purple-500/15 text-purple-300'
                : 'text-gray-400 hover:text-white',
            )}
          >
            {f.label}
          </button>
        ))}
        <select
          value={order}
          onChange={(e) => setOrder(e.target.value as 'newest' | 'oldest')}
          aria-label="Sort by date"
          className="ml-auto rounded-md border border-gray-700 bg-gray-900 px-2 py-0.5 text-gray-200"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-gray-500">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Date</th>
              <th className="py-1.5 pr-3 font-medium">What</th>
              <th className="py-1.5 pr-3 text-right font-medium">Amount</th>
              <th className="py-1.5 pr-3 text-right font-medium">Paid / received</th>
              <th className="py-1.5 pr-3 text-right font-medium">Price per {unit}</th>
              <th className="py-1.5 pr-3 text-right font-medium">Cost basis</th>
              <th className="py-1.5 pr-3 text-right font-medium">P/L</th>
              <th className="py-1.5 text-right font-medium">Gas</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {rows.slice(0, limit).map((t, i) => {
              const url = txExplorerUrl(position.chain, t.txHash);
              const moved = t.kind === 'received' || t.kind === 'sent' || t.kind === 'burned';
              return (
                <tr key={`${t.txHash}:${t.kind}:${i}`} className="align-top">
                  <td className="whitespace-nowrap py-1.5 pr-3 text-gray-400">
                    {new Date(t.at).toLocaleDateString()}
                  </td>
                  <td
                    className={cn(
                      'whitespace-nowrap py-1.5 pr-3',
                      KIND_CLASS[t.kind] ?? 'text-gray-300',
                    )}
                  >
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open this transaction on ${explorerName(position.chain)}`}
                        className="underline decoration-gray-600 underline-offset-2 hover:text-purple-300"
                      >
                        {KIND_LABELS[t.kind]} <span aria-hidden="true">↗</span>
                      </a>
                    ) : (
                      KIND_LABELS[t.kind]
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-gray-200">
                    {qty(t.qty)} {unit}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-gray-300">
                    {moved ? (
                      <span className="text-gray-500">—</span>
                    ) : (
                      <Dual usd={t.usd} native={t.native} symbol={sym} />
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-gray-400">
                    {!moved && t.usd !== null && t.qty > 0 ? usd(t.usd / t.qty) : '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-gray-400">
                    {t.costBasisUsd !== null ? usd(t.costBasisUsd) : '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {t.kind === 'sell' ? (
                      <Dual usd={t.pnlUsd} native={t.pnlNative} symbol={sym} signed />
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-gray-500">
                    {t.gasUsd > 0 ? usd(t.gasUsd) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <button
          type="button"
          onClick={() => setLimit(limit + PAGE)}
          className="mt-2 text-xs text-gray-400 hover:text-white"
        >
          Show more ({rows.length - limit} remaining)
        </button>
      )}
      {rows.length === 0 && <p className="py-3 text-center text-xs text-gray-500">Nothing here.</p>}
      <p className="mt-2 text-[11px] text-gray-500">
        P/L on a sale uses the average cost of everything held at the time (cost basis column).
      </p>
    </div>
  );
}
