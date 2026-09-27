'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { CashflowCategory, CashflowMonth, CashflowPosition, CashflowReport, CashflowResponse, CashflowTxType } from '@nexus/types';
import { AuthGate } from '@/components/wallet/auth-gate';
import { ErrorBoundary } from '@/components/error-boundary';
import { useAuth } from '@/context/auth-context';
import { getMyCashflow } from '@/lib/api';
import { cn, truncateAddress } from '@/lib/utils';
import { CashflowChart, IN_COLOR, OUT_COLOR } from './cashflow-chart';
import {
  CATEGORY_LABELS,
  CHAIN_LABELS,
  IN_CATEGORIES,
  OUT_CATEGORIES,
  TX_TYPE_LABELS,
  addressExplorerUrl,
  monthLabel,
  pnlClass,
  qty,
  relativeTime,
  txExplorerUrl,
  usd,
  usdSigned,
} from './format';

const POLL_MS = 3000;

export default function MoneyPage() {
  return (
    <ErrorBoundary>
      <AuthGate>
        <MoneyContent />
      </AuthGate>
    </ErrorBoundary>
  );
}

function MoneyContent() {
  const { accessToken } = useAuth();
  const [response, setResponse] = useState<CashflowResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (refresh = false) => {
      if (!accessToken) return;
      try {
        setError(null);
        setResponse(await getMyCashflow(accessToken, refresh));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load your money dashboard');
      }
    },
    [accessToken],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The report builds in the background on the API — poll until it's done.
  useEffect(() => {
    if (response?.status !== 'computing') return;
    const t = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(t);
  }, [response, load]);

  const report: CashflowReport | null =
    response?.status === 'ready' ? response.report : response && 'previous' in response ? response.previous : null;
  const computing = response?.status === 'computing';

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Money</h1>
          <p className="mt-1 text-sm text-gray-400">
            What came in, what went out, and whether your trades made money — across all your linked wallets.
          </p>
        </div>
        {response && response.status !== 'no_wallets' && (
          <div className="flex items-center gap-3 text-xs text-gray-500">
            {report && !computing && <span>Updated {relativeTime(report.generatedAt)}</span>}
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={computing}
              className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {computing ? 'Scanning…' : 'Refresh'}
            </button>
          </div>
        )}
      </div>

      {error && <div className="mb-6 rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">{error}</div>}

      {!response && !error && <p className="text-sm text-gray-400">Loading…</p>}

      {response?.status === 'no_wallets' && (
        <div className="rounded-xl border border-gray-800 p-8 text-center">
          <p className="text-gray-300">Link a wallet to see where your money went.</p>
          <Link href="/me" className="mt-4 inline-block rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500">
            Link a wallet
          </Link>
        </div>
      )}

      {computing && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900/50 p-4 text-sm text-gray-300" role="status">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-600 border-t-purple-400" />
          <span>
            {response.progress}
            <span className="ml-2 text-gray-500">Reading your full on-chain history — active wallets can take a few minutes.</span>
          </span>
        </div>
      )}

      {response?.status === 'failed' && (
        <div className="mb-6 rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
          Couldn&apos;t build your report: {response.error}
        </div>
      )}

      {report && <Dashboard report={report} />}
    </div>
  );
}

type Range = 'all' | '12m' | '6m' | '3m';
const RANGES: Array<{ id: Range; label: string; months: number | null }> = [
  { id: 'all', label: 'All time', months: null },
  { id: '12m', label: '12 months', months: 12 },
  { id: '6m', label: '6 months', months: 6 },
  { id: '3m', label: '3 months', months: 3 },
];

function filterMonths(months: CashflowMonth[], range: Range): CashflowMonth[] {
  const n = RANGES.find((r) => r.id === range)?.months;
  if (!n) return months;
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1)).toISOString().slice(0, 7);
  return months.filter((m) => m.month >= start);
}

function Dashboard({ report }: { report: CashflowReport }) {
  const [range, setRange] = useState<Range>('all');
  const months = useMemo(() => filterMonths(report.months, range), [report.months, range]);

  const totals = useMemo(() => {
    const byCategory: Partial<Record<CashflowCategory, number>> = {};
    let inUsd = 0;
    let outUsd = 0;
    let feesUsd = 0;
    let realized = 0;
    for (const m of months) {
      inUsd += m.inUsd;
      outUsd += m.outUsd;
      feesUsd += m.feesUsd;
      realized += m.realizedPnlUsd;
      for (const [k, v] of Object.entries(m.byCategory) as Array<[CashflowCategory, number]>) byCategory[k] = (byCategory[k] ?? 0) + v;
    }
    return { inUsd, outUsd, feesUsd, realized, net: inUsd - outUsd, byCategory };
  }, [months]);

  if (report.totals.txCount === 0) {
    return (
      <div className="rounded-xl border border-gray-800 p-8 text-center text-gray-400">
        No transactions found yet for your linked wallets.
        <Coverage report={report} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setRange(r.id)}
            aria-pressed={range === r.id}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm transition-colors',
              range === r.id ? 'bg-purple-500/15 text-purple-300' : 'text-gray-400 hover:bg-gray-800 hover:text-white',
            )}
          >
            {r.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-500">
          {report.wallets.length} linked wallet{report.wallets.length === 1 ? '' : 's'} · {report.totals.txCount.toLocaleString()} transactions
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Money in" value={usd(totals.inUsd)} swatch={IN_COLOR} />
        <Stat label="Money out" value={usd(totals.outUsd)} swatch={OUT_COLOR} />
        <Stat label="Net cash flow" value={usdSigned(totals.net)} valueClass={pnlClass(totals.net)} />
        <Stat label="Realized profit / loss" value={usdSigned(totals.realized)} valueClass={pnlClass(totals.realized)} />
        <Stat label="Gas & fees" value={usd(totals.feesUsd)} />
      </div>

      <section className="rounded-xl border border-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold">Money in vs. out by month</h2>
        {months.length > 0 ? <CashflowChart months={months} /> : <p className="text-sm text-gray-500">No activity in this range.</p>}
        {months.length > 0 && <MonthTable months={months} />}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <Breakdown title="Where your money went" categories={OUT_CATEGORIES} byCategory={totals.byCategory} total={totals.outUsd} color={OUT_COLOR} />
        <Breakdown title="Where your money came from" categories={IN_CATEGORIES} byCategory={totals.byCategory} total={totals.inUsd} color={IN_COLOR} />
      </div>

      <DetailTabs report={report} />

      <Coverage report={report} />
    </div>
  );
}

function Stat({ label, value, valueClass, swatch }: { label: string; value: string; valueClass?: string; swatch?: string }) {
  return (
    <div className="rounded-lg border border-gray-800 p-3">
      <div className="flex items-center gap-1.5 text-xs text-gray-500">
        {swatch && <span className="inline-block h-2 w-2 rounded-sm" style={{ background: swatch }} aria-hidden="true" />}
        {label}
      </div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums', valueClass)}>{value}</div>
    </div>
  );
}

function MonthTable({ months }: { months: CashflowMonth[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4">
      <button type="button" onClick={() => setOpen(!open)} className="text-xs text-gray-400 hover:text-white" aria-expanded={open}>
        {open ? 'Hide table' : 'Show as table'}
      </button>
      {open && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Month</th>
                <th className="py-2 pr-4 text-right font-medium">In</th>
                <th className="py-2 pr-4 text-right font-medium">Out</th>
                <th className="py-2 pr-4 text-right font-medium">of which gas</th>
                <th className="py-2 pr-4 text-right font-medium">Net</th>
                <th className="py-2 text-right font-medium">Realized PnL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/70">
              {[...months].reverse().map((m) => (
                <tr key={m.month}>
                  <td className="py-2 pr-4 text-gray-300">{monthLabel(m.month, 'long')}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{usd(m.inUsd)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{usd(m.outUsd)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-400">{usd(m.feesUsd)}</td>
                  <td className={cn('py-2 pr-4 text-right tabular-nums', pnlClass(m.inUsd - m.outUsd))}>{usdSigned(m.inUsd - m.outUsd)}</td>
                  <td className={cn('py-2 text-right tabular-nums', pnlClass(m.realizedPnlUsd))}>{usdSigned(m.realizedPnlUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Breakdown({
  title,
  categories,
  byCategory,
  total,
  color,
}: {
  title: string;
  categories: CashflowCategory[];
  byCategory: Partial<Record<CashflowCategory, number>>;
  total: number;
  color: string;
}) {
  const rows = categories.map((c) => ({ c, v: byCategory[c] ?? 0 })).sort((a, b) => b.v - a.v);
  const max = Math.max(...rows.map((r) => r.v), 1);
  return (
    <section className="rounded-xl border border-gray-800 p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-sm tabular-nums text-gray-400">{usd(total)}</span>
      </div>
      <ul className="space-y-3">
        {rows.map(({ c, v }) => (
          <li key={c}>
            <div className="mb-1 flex justify-between text-sm">
              <span className="text-gray-300">{CATEGORY_LABELS[c]}</span>
              <span className="tabular-nums text-gray-200">
                {usd(v)}
                <span className="ml-2 text-xs text-gray-500">{total > 0 ? `${Math.round((v / total) * 100)}%` : '—'}</span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-gray-800/60">
              {v > 0 && <div className="h-2 rounded-full" style={{ width: `${Math.max((v / max) * 100, 1)}%`, background: color }} />}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Tab = 'collections' | 'tokens' | 'counterparties' | 'fees' | 'activity';

function DetailTabs({ report }: { report: CashflowReport }) {
  const [tab, setTab] = useState<Tab>('collections');
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'collections', label: `NFT collections (${report.collections.length})` },
    { id: 'tokens', label: `Tokens (${report.tokens.length})` },
    { id: 'counterparties', label: `Sent & received (${report.counterparties.length})` },
    { id: 'fees', label: 'Gas by chain' },
    { id: 'activity', label: 'Activity' },
  ];
  return (
    <section className="rounded-xl border border-gray-800">
      <div className="flex gap-1 overflow-x-auto border-b border-gray-800 px-4" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-3 text-sm transition-colors',
              tab === t.id ? 'border-purple-400 text-white' : 'border-transparent text-gray-400 hover:text-white',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-4 md:p-6">
        {tab === 'collections' && <PositionsTable rows={report.collections} kind="nft" />}
        {tab === 'tokens' && <PositionsTable rows={report.tokens} kind="fungible" />}
        {tab === 'counterparties' && <CounterpartiesTable report={report} />}
        {tab === 'fees' && <FeesTable report={report} />}
        {tab === 'activity' && <ActivityList report={report} />}
      </div>
    </section>
  );
}

function PositionsTable({ rows, kind }: { rows: CashflowPosition[]; kind: 'nft' | 'fungible' }) {
  const [showAll, setShowAll] = useState(false);
  // Spam airdrops never involve money — hide them unless asked.
  const traded = rows.filter((r) => r.spentUsd > 0 || r.proceedsUsd > 0);
  const visible = showAll ? rows : traded;
  const totals = traded.reduce(
    (acc, r) => ({ spent: acc.spent + r.spentUsd, proceeds: acc.proceeds + r.proceedsUsd, pnl: acc.pnl + r.realizedPnlUsd, open: acc.open + r.openCostBasisUsd }),
    { spent: 0, proceeds: 0, pnl: 0, open: 0 },
  );
  const unit = kind === 'nft' ? 'items' : 'amount';

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total spent" value={usd(totals.spent)} />
        <Stat label="Total sold for" value={usd(totals.proceeds)} />
        <Stat label="Realized profit / loss" value={usdSigned(totals.pnl)} valueClass={pnlClass(totals.pnl)} />
        <Stat label="Cost of what you still hold" value={usd(totals.open)} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr>
              <th className="py-2 pr-4 font-medium">{kind === 'nft' ? 'Collection' : 'Token'}</th>
              <th className="py-2 pr-4 text-right font-medium">Bought ({unit})</th>
              <th className="py-2 pr-4 text-right font-medium">Spent</th>
              <th className="py-2 pr-4 text-right font-medium">Sold ({unit})</th>
              <th className="py-2 pr-4 text-right font-medium">Sold for</th>
              <th className="py-2 pr-4 text-right font-medium">Realized P/L</th>
              <th className="py-2 text-right font-medium">Still held</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/70">
            {visible.map((r) => (
              <tr key={r.key}>
                <td className="py-2 pr-4">
                  <div className="font-medium text-gray-200">{r.name}</div>
                  <div className="text-xs text-gray-500">
                    {CHAIN_LABELS[r.chain] ?? r.chain}
                    {r.symbol && kind === 'fungible' && r.symbol !== r.name ? ` · ${r.symbol}` : ''}
                  </div>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-300">{r.qtyBought ? qty(r.qtyBought) : '—'}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{r.spentUsd ? usd(r.spentUsd) : '—'}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-300">{r.qtySold ? qty(r.qtySold) : '—'}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{r.proceedsUsd ? usd(r.proceedsUsd) : '—'}</td>
                <td className={cn('py-2 pr-4 text-right tabular-nums', pnlClass(r.realizedPnlUsd))}>
                  {r.sellCount > 0 ? usdSigned(r.realizedPnlUsd) : '—'}
                  {r.qtySoldWithoutBasis > 0 && (
                    <span
                      className="ml-1 cursor-help text-xs text-yellow-500"
                      title={`${qty(r.qtySoldWithoutBasis)} sold without a recorded purchase (airdrop, gift, or older than the scanned history) — counted at $0 cost.`}
                    >
                      *
                    </span>
                  )}
                </td>
                <td className="py-2 text-right tabular-nums text-gray-300">
                  {r.qtyHeld > 0 ? qty(r.qtyHeld) : '—'}
                  {r.openCostBasisUsd > 0 && <div className="text-xs text-gray-500">cost {usd(r.openCostBasisUsd)}</div>}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-gray-500">
                  No {kind === 'nft' ? 'NFT' : 'token'} buys or sales found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > traded.length && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="mt-3 text-xs text-gray-400 hover:text-white">
          {showAll ? 'Hide' : 'Show'} {rows.length - traded.length} with no money involved (airdrops, free mints, spam)
        </button>
      )}
    </div>
  );
}

function CounterpartiesTable({ report }: { report: CashflowReport }) {
  const sent = report.counterparties.reduce((s, c) => s + c.sentUsd, 0);
  const received = report.counterparties.reduce((s, c) => s + c.receivedUsd, 0);
  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Sent to other wallets" value={usd(sent)} swatch={OUT_COLOR} />
        <Stat label="Received from other wallets" value={usd(received)} swatch={IN_COLOR} />
        <Stat
          label="Moved between your own wallets"
          value={`${report.ownWalletTransfers.count} tx · ${usd(report.ownWalletTransfers.usd)}`}
        />
      </div>
      <p className="mb-3 text-xs text-gray-500">
        Plain transfers of ETH/SOL/POL/APE and stablecoins. Transfers between your own linked wallets are excluded from in/out.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr>
              <th className="py-2 pr-4 font-medium">Address</th>
              <th className="py-2 pr-4 text-right font-medium">Sent to</th>
              <th className="py-2 pr-4 text-right font-medium">Received from</th>
              <th className="py-2 pr-4 text-right font-medium">Net</th>
              <th className="py-2 text-right font-medium">Last</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/70">
            {report.counterparties.map((c) => {
              const url = addressExplorerUrl(c.chain, c.address);
              return (
                <tr key={`${c.chain}:${c.address}`}>
                  <td className="py-2 pr-4">
                    {url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono text-gray-200 hover:text-purple-300">
                        {c.address.length > 16 ? truncateAddress(c.address) : c.address}
                      </a>
                    ) : (
                      <span className="font-mono text-gray-200">{c.address}</span>
                    )}
                    <div className="text-xs text-gray-500">{CHAIN_LABELS[c.chain] ?? c.chain}</div>
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {c.sentUsd ? usd(c.sentUsd) : '—'}
                    {c.sentCount > 0 && <div className="text-xs text-gray-500">{c.sentCount}×</div>}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {c.receivedUsd ? usd(c.receivedUsd) : '—'}
                    {c.receivedCount > 0 && <div className="text-xs text-gray-500">{c.receivedCount}×</div>}
                  </td>
                  <td className={cn('py-2 pr-4 text-right tabular-nums', pnlClass(c.receivedUsd - c.sentUsd))}>
                    {usdSigned(c.receivedUsd - c.sentUsd)}
                  </td>
                  <td className="py-2 text-right text-xs text-gray-500">{new Date(c.lastAt).toLocaleDateString()}</td>
                </tr>
              );
            })}
            {report.counterparties.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-gray-500">
                  No transfers to or from other wallets.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FeesTable({ report }: { report: CashflowReport }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-gray-500">
          <tr>
            <th className="py-2 pr-4 font-medium">Chain</th>
            <th className="py-2 pr-4 text-right font-medium">Transactions paid</th>
            <th className="py-2 pr-4 text-right font-medium">Fees (native)</th>
            <th className="py-2 pr-4 text-right font-medium">Fees (USD)</th>
            <th className="py-2 text-right font-medium">Avg per tx</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/70">
          {report.fees.map((f) => (
            <tr key={f.chain}>
              <td className="py-2 pr-4 text-gray-200">{CHAIN_LABELS[f.chain] ?? f.chain}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{f.txCount.toLocaleString()}</td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {qty(f.feesNative)} {f.symbol}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">{usd(f.feesUsd)}</td>
              <td className="py-2 text-right tabular-nums text-gray-400">{usd(f.txCount ? f.feesUsd / f.txCount : 0)}</td>
            </tr>
          ))}
          {report.fees.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-gray-500">
                No fees paid.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const ACTIVITY_FILTERS: Array<{ id: string; label: string; types: CashflowTxType[] | null }> = [
  { id: 'all', label: 'All', types: null },
  { id: 'buys', label: 'Buys & mints', types: ['nft_purchase', 'nft_mint', 'token_purchase'] },
  { id: 'sales', label: 'Sales', types: ['nft_sale', 'token_sale'] },
  { id: 'transfers', label: 'Transfers', types: ['transfer_in', 'transfer_out', 'sent_asset', 'received_asset', 'own_wallet_transfer'] },
  { id: 'swaps', label: 'Swaps', types: ['swap'] },
];
const PAGE = 50;

function ActivityList({ report }: { report: CashflowReport }) {
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(PAGE);
  const types = ACTIVITY_FILTERS.find((f) => f.id === filter)?.types;
  // "All" skips unsolicited airdrops (no money, no gas) — they're still under Transfers.
  const rows = types
    ? report.activity.filter((a) => types.includes(a.type))
    : report.activity.filter((a) => !(a.type === 'received_asset' && a.inUsd === 0 && a.outUsd === 0));

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
              filter === f.id ? 'bg-purple-500/15 text-purple-300' : 'text-gray-400 hover:bg-gray-800 hover:text-white',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ul className="divide-y divide-gray-800/70">
        {rows.slice(0, limit).map((a) => {
          const url = txExplorerUrl(a.chain, a.txHash);
          const net = a.inUsd - a.outUsd;
          return (
            <li key={`${a.chain}:${a.txHash}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
              <div className="w-24 shrink-0 text-xs text-gray-500">
                {new Date(a.timestamp).toLocaleDateString()}
                <div>{CHAIN_LABELS[a.chain] ?? a.chain}</div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-300">{TX_TYPE_LABELS[a.type]}</span>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="truncate text-sm text-gray-200 hover:text-purple-300">
                      {a.label}
                    </a>
                  ) : (
                    <span className="truncate text-sm text-gray-200">{a.label}</span>
                  )}
                </div>
                {a.counterparty && <div className="mt-0.5 font-mono text-xs text-gray-500">{truncateAddress(a.counterparty)}</div>}
              </div>
              <div className="text-right text-sm tabular-nums">
                {(a.inUsd > 0 || a.outUsd > 0) && <div className={pnlClass(net)}>{usdSigned(net)}</div>}
                {a.realizedPnlUsd !== null && (
                  <div className={cn('text-xs', pnlClass(a.realizedPnlUsd))}>P/L {usdSigned(a.realizedPnlUsd)}</div>
                )}
                {a.feeUsd > 0 && <div className="text-xs text-gray-500">gas {usd(a.feeUsd)}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      {rows.length > limit && (
        <button type="button" onClick={() => setLimit(limit + PAGE)} className="mt-3 text-xs text-gray-400 hover:text-white">
          Show more ({rows.length - limit} remaining)
        </button>
      )}
      {rows.length === 0 && <p className="py-6 text-center text-sm text-gray-500">Nothing here.</p>}
    </div>
  );
}

function Coverage({ report }: { report: CashflowReport }) {
  const failed = report.coverage.filter((c) => c.error);
  return (
    <details className="rounded-xl border border-gray-800 p-4 text-sm text-gray-400">
      <summary className="cursor-pointer text-gray-300">How these numbers are calculated</summary>
      <ul className="mt-3 list-disc space-y-1 pl-5">
        <li>Money in/out counts native coins (ETH, SOL, POL, APE), their wrapped versions, and USD stablecoins, valued at that day&apos;s price.</li>
        <li>Profit/loss per NFT is sale price minus what you paid for that exact token; tokens use average cost. Gas is tracked separately, not added to cost.</li>
        <li>Swaps between two coins count as conversions, not spending. Moves between your own linked wallets are excluded.</li>
        {report.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      {failed.length > 0 && (
        <div className="mt-3 text-yellow-500">
          Couldn&apos;t scan:{' '}
          {failed.map((c) => `${CHAIN_LABELS[c.chain] ?? c.chain} ${truncateAddress(c.address)}`).join(', ')}. Try Refresh later.
        </div>
      )}
    </details>
  );
}
