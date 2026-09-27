'use client';

import { useMemo, useState } from 'react';
import type {
  CashflowNftAcquiredVia,
  CashflowNftDisposedVia,
  CashflowNftItem,
  CashflowPosition,
} from '@nexus/types';
import { cn } from '@/lib/utils';
import { nativeAmount, pnlClass, txExplorerUrl, usd, usdSigned } from './format';

const ACQUIRED_LABELS: Record<CashflowNftAcquiredVia, string> = {
  purchase: 'Bought',
  mint: 'Minted',
  free_mint: 'Free mint',
  received: 'Received',
  swap: 'Swapped in',
  unknown: 'Origin unknown',
};

const DISPOSED_LABELS: Record<CashflowNftDisposedVia, string> = {
  sale: 'Sold',
  sent: 'Sent away',
  burned: 'Burned',
  swap: 'Swapped out',
};

type Filter = 'all' | 'sold' | 'held';
type Sort = 'recent' | 'best' | 'worst' | 'longest';
const PAGE = 50;

function formatHold(seconds: number | null): string {
  if (seconds === null) return '—';
  const days = seconds / 86400;
  if (days < 1) return `${Math.max(1, Math.round(seconds / 3600))} h`;
  if (days < 60) return `${Math.round(days)} d`;
  return `${(days / 30.44).toFixed(1)} mo`;
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString();

function TxLink({
  chain,
  hash,
  children,
}: {
  chain: string;
  hash: string | null;
  children: React.ReactNode;
}) {
  const url = hash ? txExplorerUrl(chain, hash) : null;
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className="hover:text-purple-300">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

function PnlText({
  item,
  native,
  symbol,
}: {
  item: CashflowNftItem;
  native: boolean;
  symbol: string;
}) {
  const v = (native ? item.realizedPnlNative : item.realizedPnlUsd) ?? 0;
  return <span className={pnlClass(v)}>{native ? nativeAmount(v, symbol) : usdSigned(v)}</span>;
}

/** One row per NFT (or per round trip when the same token was flipped more than once). */
export function NftItemsTable({
  position,
  native,
}: {
  position: CashflowPosition;
  native: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [limit, setLimit] = useState(PAGE);
  const items = position.items;
  const sym = position.nativeSymbol;
  const pnlOf = (i: CashflowNftItem) => (native ? i.realizedPnlNative : i.realizedPnlUsd);

  const summary = useMemo(() => {
    const pnl = (i: CashflowNftItem) => (native ? i.realizedPnlNative : i.realizedPnlUsd);
    const sold = items.filter((i) => pnl(i) !== null);
    const winners = sold.filter((i) => (pnl(i) ?? 0) > 0);
    const ranked = [...sold].sort((a, b) => (pnl(b) ?? 0) - (pnl(a) ?? 0));
    const holds = sold.map((i) => i.holdSeconds).filter((h): h is number => h !== null);
    return {
      sold: sold.length,
      winners: winners.length,
      best: ranked[0] ?? null,
      worst: ranked.length > 1 ? ranked[ranked.length - 1] : null,
      avgHold: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
      held: items.filter((i) => i.disposedAt === null).length,
    };
  }, [items, native]);

  const rows = useMemo(() => {
    const filtered = items.filter((i) =>
      filter === 'sold'
        ? i.disposedVia === 'sale'
        : filter === 'held'
          ? i.disposedAt === null
          : true,
    );
    if (sort === 'recent') return filtered; // already newest first from the API
    const pnl = (i: CashflowNftItem) => (native ? i.realizedPnlNative : i.realizedPnlUsd);
    return [...filtered].sort((a, b) => {
      if (sort === 'longest') return (b.holdSeconds ?? -1) - (a.holdSeconds ?? -1);
      // Unsold items sink to the bottom for win/loss sorts.
      const pa = pnl(a);
      const pb = pnl(b);
      if (pa === null || pb === null) return pa === null ? (pb === null ? 0 : 1) : -1;
      return sort === 'best' ? pb - pa : pa - pb;
    });
  }, [items, filter, sort, native]);

  const money = (usdValue: number | null, nativeValue: number | null, signed = false) => {
    if (native) return nativeValue === null ? '—' : nativeAmount(nativeValue, sym, signed);
    if (usdValue === null) return '—';
    return signed ? usdSigned(usdValue) : usd(usdValue);
  };

  if (items.length === 0) {
    return (
      <p className="py-3 text-xs text-gray-500">
        No individual items recorded (the transfers didn&apos;t include token IDs).
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
        <span>
          <span className="text-gray-200">{summary.sold}</span> sold
          {summary.sold > 0 && (
            <>
              {' '}
              · <span className="text-gray-200">{summary.winners}</span> at a profit (
              {Math.round((summary.winners / summary.sold) * 100)}%)
            </>
          )}
        </span>
        {summary.best && (
          <span>
            best <PnlText item={summary.best} native={native} symbol={sym} /> (#
            {summary.best.tokenId})
          </span>
        )}
        {summary.worst && (
          <span>
            worst <PnlText item={summary.worst} native={native} symbol={sym} /> (#
            {summary.worst.tokenId})
          </span>
        )}
        {summary.avgHold !== null && <span>avg hold {formatHold(summary.avgHold)}</span>}
        <span>
          <span className="text-gray-200">{summary.held}</span> still held
        </span>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="group" aria-label="Filter items">
          {(
            [
              ['all', 'All'],
              ['sold', 'Sold'],
              ['held', 'Still held'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => {
                setFilter(id);
                setLimit(PAGE);
              }}
              className={cn(
                'rounded-md px-2 py-0.5 text-xs transition-colors',
                filter === id
                  ? 'bg-purple-500/15 text-purple-300'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          aria-label="Sort items"
          className="ml-auto rounded-md border border-gray-700 bg-gray-900 px-2 py-0.5 text-xs text-gray-200"
        >
          <option value="recent">Most recent</option>
          <option value="best">Biggest profit</option>
          <option value="worst">Biggest loss</option>
          <option value="longest">Longest held</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-gray-500">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Token</th>
              <th className="py-1.5 pr-3 font-medium">Acquired</th>
              <th className="py-1.5 pr-3 text-right font-medium">Cost</th>
              <th className="py-1.5 pr-3 font-medium">Left your wallets</th>
              <th className="py-1.5 pr-3 text-right font-medium">Sold for</th>
              <th className="py-1.5 pr-3 text-right font-medium">P/L</th>
              {!native && <th className="py-1.5 pr-3 text-right font-medium">After gas</th>}
              <th className="py-1.5 text-right font-medium">Held</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {rows.slice(0, limit).map((i, idx) => {
              const pnl = pnlOf(i);
              return (
                <tr
                  key={`${i.tokenId}:${i.acquireTxHash ?? 'x'}:${i.disposeTxHash ?? 'open'}:${idx}`}
                >
                  <td className="py-1.5 pr-3 font-mono text-gray-200">
                    #
                    {i.tokenId.length > 12
                      ? `${i.tokenId.slice(0, 6)}…${i.tokenId.slice(-4)}`
                      : i.tokenId}
                    {i.qty !== 1 && <span className="ml-1 text-gray-500">×{i.qty}</span>}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-gray-400">
                    <TxLink chain={position.chain} hash={i.acquireTxHash}>
                      {ACQUIRED_LABELS[i.acquiredVia]}
                      {i.acquiredAt && (
                        <span className="text-gray-500"> · {shortDate(i.acquiredAt)}</span>
                      )}
                    </TxLink>
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-gray-300">
                    {i.acquiredVia === 'unknown' ? '—' : money(i.costUsd, i.costNative)}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-gray-400">
                    {i.disposedVia && i.disposedAt ? (
                      <TxLink chain={position.chain} hash={i.disposeTxHash}>
                        {DISPOSED_LABELS[i.disposedVia]}
                        <span className="text-gray-500"> · {shortDate(i.disposedAt)}</span>
                      </TxLink>
                    ) : (
                      <span className="text-gray-500">Still held</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-gray-300">
                    {money(i.proceedsUsd, i.proceedsNative)}
                  </td>
                  <td
                    className={cn(
                      'py-1.5 pr-3 text-right tabular-nums',
                      pnl !== null && pnlClass(pnl),
                    )}
                  >
                    {pnl === null ? '—' : native ? nativeAmount(pnl, sym) : usdSigned(pnl)}
                    {i.acquiredVia === 'unknown' && i.realizedPnlUsd !== null && (
                      <span
                        className="ml-1 cursor-help text-yellow-500"
                        title="Purchase not found in your history — counted at $0 cost."
                      >
                        *
                      </span>
                    )}
                  </td>
                  {!native && (
                    <td
                      className={cn(
                        'py-1.5 pr-3 text-right tabular-nums',
                        i.realizedPnlAfterGasUsd !== null && pnlClass(i.realizedPnlAfterGasUsd),
                      )}
                      title={`Gas: ${usd(i.buyGasUsd)} to acquire, ${usd(i.sellGasUsd)} to ${i.disposedVia === 'sale' ? 'sell' : 'move'}`}
                    >
                      {i.realizedPnlAfterGasUsd === null
                        ? '—'
                        : usdSigned(i.realizedPnlAfterGasUsd)}
                    </td>
                  )}
                  <td className="py-1.5 text-right tabular-nums text-gray-400">
                    {i.disposedAt
                      ? formatHold(i.holdSeconds)
                      : i.acquiredAt
                        ? formatHold((Date.now() - Date.parse(i.acquiredAt)) / 1000)
                        : '—'}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={native ? 7 : 8} className="py-4 text-center text-gray-500">
                  Nothing here.
                </td>
              </tr>
            )}
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
    </div>
  );
}
