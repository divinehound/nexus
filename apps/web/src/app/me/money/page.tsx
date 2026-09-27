'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { CashflowCategory, CashflowMonth, CashflowPosition, CashflowReport, CashflowResponse } from '@nexus/types';
import { AuthGate } from '@/components/wallet/auth-gate';
import { ErrorBoundary } from '@/components/error-boundary';
import { useAuth } from '@/context/auth-context';
import { getMyCashflow } from '@/lib/api';
import { cn, truncateAddress } from '@/lib/utils';
import { CashflowActionsProvider } from './actions';
import { ActivityList } from './activity-list';
import { CashflowChart, IN_COLOR, OUT_COLOR } from './cashflow-chart';
import { CounterpartiesTable } from './counterparties';
import { AfterGas, Stat } from './ui';
import {
  CATEGORY_LABELS,
  CHAIN_LABELS,
  IN_CATEGORIES,
  OUT_CATEGORIES,
  monthLabel,
  nativeAmount,
  pnlClass,
  qty,
  relativeTime,
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

      {report && (
        <CashflowActionsProvider token={accessToken} onResponse={setResponse}>
          <Dashboard report={report} />
        </CashflowActionsProvider>
      )}
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
    let realizedAfterGas = 0;
    for (const m of months) {
      inUsd += m.inUsd;
      outUsd += m.outUsd;
      feesUsd += m.feesUsd;
      realized += m.realizedPnlUsd;
      realizedAfterGas += m.realizedPnlAfterGasUsd;
      for (const [k, v] of Object.entries(m.byCategory) as Array<[CashflowCategory, number]>) byCategory[k] = (byCategory[k] ?? 0) + v;
    }
    const netInvested = (byCategory.exchange_withdrawal ?? 0) - (byCategory.exchange_deposit ?? 0);
    return { inUsd, outUsd, feesUsd, realized, realizedAfterGas, net: inUsd - outUsd, netInvested, byCategory };
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Money in" value={usd(totals.inUsd)} swatch={IN_COLOR} />
        <Stat label="Money out" value={usd(totals.outUsd)} swatch={OUT_COLOR} />
        <Stat label="Net cash flow" value={usdSigned(totals.net)} valueClass={pnlClass(totals.net)} />
        <Stat
          label="Realized profit / loss"
          value={usdSigned(totals.realized)}
          valueClass={pnlClass(totals.realized)}
          sub={<AfterGas value={totals.realizedAfterGas} />}
        />
        <Stat label="Gas & fees" value={usd(totals.feesUsd)} />
        <Stat
          label="Net invested from exchanges"
          value={usdSigned(totals.netInvested)}
          sub={`${usd(totals.byCategory.exchange_withdrawal ?? 0)} in · ${usd(totals.byCategory.exchange_deposit ?? 0)} cashed out`}
        />
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
                <th className="py-2 pr-4 text-right font-medium">Realized P/L</th>
                <th className="py-2 text-right font-medium">P/L after gas</th>
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
                  <td className={cn('py-2 pr-4 text-right tabular-nums', pnlClass(m.realizedPnlUsd))}>{usdSigned(m.realizedPnlUsd)}</td>
                  <td className={cn('py-2 text-right tabular-nums', pnlClass(m.realizedPnlAfterGasUsd))}>
                    {usdSigned(m.realizedPnlAfterGasUsd)}
                  </td>
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
  const [unit, setUnit] = useState<Unit>('usd');
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'collections', label: `NFT collections (${report.collections.length})` },
    { id: 'tokens', label: `Tokens (${report.tokens.length})` },
    { id: 'counterparties', label: 'Transfers & exchanges' },
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
        {tab === 'collections' && <PositionsTable rows={report.collections} kind="nft" unit={unit} setUnit={setUnit} />}
        {tab === 'tokens' && <PositionsTable rows={report.tokens} kind="fungible" unit={unit} setUnit={setUnit} />}
        {tab === 'counterparties' && <CounterpartiesTable report={report} />}
        {tab === 'fees' && <FeesTable report={report} />}
        {tab === 'activity' && <ActivityList report={report} />}
      </div>
    </section>
  );
}

type Unit = 'usd' | 'native';

/** Sum a native-coin field per symbol and format as "+0.4 ETH · −12 SOL". */
function perSymbol(rows: CashflowPosition[], pick: (r: CashflowPosition) => number, signed: boolean): string {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r.nativeSymbol, (sums.get(r.nativeSymbol) ?? 0) + pick(r));
  const parts = [...sums.entries()].filter(([, v]) => Math.abs(v) > 1e-9).map(([sym, v]) => nativeAmount(v, sym, signed));
  return parts.length ? parts.join(' · ') : '—';
}

function UnitToggle({ unit, setUnit }: { unit: Unit; setUnit: (u: Unit) => void }) {
  return (
    <div className="flex items-center gap-2 text-xs text-gray-400" role="group" aria-label="Show values in">
      <span>Show values in</span>
      {(
        [
          ['usd', 'USD'],
          ['native', 'Coin (ETH, SOL…)'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={unit === id}
          onClick={() => setUnit(id)}
          className={cn(
            'rounded-md px-2 py-1 transition-colors',
            unit === id ? 'bg-purple-500/15 text-purple-300' : 'hover:bg-gray-800 hover:text-white',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function PositionsTable({
  rows,
  kind,
  unit,
  setUnit,
}: {
  rows: CashflowPosition[];
  kind: 'nft' | 'fungible';
  unit: Unit;
  setUnit: (u: Unit) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  // Spam airdrops never involve money — hide them unless asked.
  const traded = rows.filter((r) => r.spentUsd > 0 || r.proceedsUsd > 0);
  const visible = showAll ? rows : traded;
  const totals = traded.reduce(
    (acc, r) => ({
      spent: acc.spent + r.spentUsd,
      proceeds: acc.proceeds + r.proceedsUsd,
      pnl: acc.pnl + r.realizedPnlUsd,
      pnlAfterGas: acc.pnlAfterGas + r.realizedPnlAfterGasUsd,
      tradeGain: acc.tradeGain + r.tradeGainUsd,
      priceMove: acc.priceMove + r.priceMoveUsd,
      gas: acc.gas + r.gasUsd,
      open: acc.open + r.openCostBasisUsd,
    }),
    { spent: 0, proceeds: 0, pnl: 0, pnlAfterGas: 0, tradeGain: 0, priceMove: 0, gas: 0, open: 0 },
  );
  const qtyUnit = kind === 'nft' ? 'items' : 'amount';
  const native = unit === 'native';

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <UnitToggle unit={unit} setUnit={setUnit} />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Total spent" value={native ? perSymbol(traded, (r) => r.spentNative, false) : usd(totals.spent)} />
        <Stat label="Total sold for" value={native ? perSymbol(traded, (r) => r.proceedsNative, false) : usd(totals.proceeds)} />
        {native ? (
          <Stat label="Realized profit / loss" value={perSymbol(traded, (r) => r.realizedPnlNative, true)} sub="in each chain's own coin" />
        ) : (
          <Stat
            label="Realized profit / loss"
            value={usdSigned(totals.pnl)}
            valueClass={pnlClass(totals.pnl)}
            sub={<AfterGas value={totals.pnlAfterGas} />}
          />
        )}
        <Stat
          label="From trading vs. coin price"
          value={usdSigned(totals.tradeGain)}
          valueClass={pnlClass(totals.tradeGain)}
          sub={
            <>
              coin price moved <span className={cn('tabular-nums', pnlClass(totals.priceMove))}>{usdSigned(totals.priceMove)}</span>
            </>
          }
        />
        <Stat label="Cost of what you still hold" value={usd(totals.open)} sub={`${usd(totals.gas)} gas spent in total`} />
      </div>
      <p className="mb-3 text-xs text-gray-500">
        {native
          ? 'Coin view: what you paid is converted to ETH/SOL/… at the buy-day price and what you received at the sale-day price, so a profit in ETH shows as a profit even if ETH fell.'
          : '“From trading” is your profit in the coin itself, valued at the sale-day price; “coin price moved” is the rest — the coin getting cheaper or pricier while you held.'}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr>
              <th className="py-2 pr-4 font-medium">{kind === 'nft' ? 'Collection' : 'Token'}</th>
              <th className="py-2 pr-4 text-right font-medium">Bought ({qtyUnit})</th>
              <th className="py-2 pr-4 text-right font-medium">Spent</th>
              <th className="py-2 pr-4 text-right font-medium">Sold ({qtyUnit})</th>
              <th className="py-2 pr-4 text-right font-medium">Sold for</th>
              <th className="py-2 pr-4 text-right font-medium" title="Sale proceeds (after marketplace fees and royalties) minus what you paid">
                Realized P/L
              </th>
              {!native && (
                <th className="py-2 pr-4 text-right font-medium" title="Also subtracts gas paid to buy or mint what you sold, and gas paid to sell it">
                  P/L after gas
                </th>
              )}
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
                <td className="py-2 pr-4 text-right tabular-nums">
                  {r.spentUsd ? (native ? nativeAmount(r.spentNative, r.nativeSymbol, false) : usd(r.spentUsd)) : '—'}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-300">{r.qtySold ? qty(r.qtySold) : '—'}</td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {r.proceedsUsd ? (native ? nativeAmount(r.proceedsNative, r.nativeSymbol, false) : usd(r.proceedsUsd)) : '—'}
                </td>
                <td
                  className={cn(
                    'py-2 pr-4 text-right tabular-nums',
                    pnlClass(native ? r.realizedPnlNative : r.realizedPnlUsd),
                  )}
                >
                  {r.sellCount > 0 ? (native ? nativeAmount(r.realizedPnlNative, r.nativeSymbol) : usdSigned(r.realizedPnlUsd)) : '—'}
                  {r.qtySoldWithoutBasis > 0 && (
                    <span
                      className="ml-1 cursor-help text-xs text-yellow-500"
                      title={`${qty(r.qtySoldWithoutBasis)} sold without a recorded purchase (airdrop, gift, or older than the scanned history) — counted at $0 cost.`}
                    >
                      *
                    </span>
                  )}
                  {!native && r.sellCount > 0 && Math.abs(r.priceMoveUsd) >= 1 && (
                    <div className="text-xs text-gray-500">
                      trade {usdSigned(r.tradeGainUsd)} · {r.nativeSymbol} price {usdSigned(r.priceMoveUsd)}
                    </div>
                  )}
                </td>
                {!native && (
                  <td className={cn('py-2 pr-4 text-right tabular-nums', pnlClass(r.realizedPnlAfterGasUsd))}>
                    {r.sellCount > 0 ? usdSigned(r.realizedPnlAfterGasUsd) : '—'}
                    {r.gasUsd > 0 && <div className="text-xs text-gray-500">{usd(r.gasUsd)} total gas</div>}
                  </td>
                )}
                <td className="py-2 text-right tabular-nums text-gray-300">
                  {r.qtyHeld > 0 ? qty(r.qtyHeld) : '—'}
                  {r.openCostBasisUsd > 0 && <div className="text-xs text-gray-500">cost {usd(r.openCostBasisUsd)}</div>}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={native ? 7 : 8} className="py-6 text-center text-gray-500">
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

function Coverage({ report }: { report: CashflowReport }) {
  const failed = report.coverage.filter((c) => c.error);
  return (
    <details className="rounded-xl border border-gray-800 p-4 text-sm text-gray-400">
      <summary className="cursor-pointer text-gray-300">How these numbers are calculated</summary>
      <ul className="mt-3 list-disc space-y-1 pl-5">
        <li>Money in/out counts native coins (ETH, SOL, POL, APE), their wrapped versions, and USD stablecoins, valued at that day&apos;s price.</li>
        <li>
          Profit/loss per NFT is what you actually received for it — after marketplace fees and royalties — minus what you paid
          for that exact token; tokens use average cost. &ldquo;P/L after gas&rdquo; also subtracts the gas you paid to buy or mint
          the items you sold and the gas on the sale; gas for items you still hold waits until you sell them.
        </li>
        <li>Swaps between two coins count as conversions, not spending.</li>
        <li>
          Moves between your own linked wallets are never counted twice: same-chain transfers are dropped, and a bridge is
          recognised by pairing money leaving one chain with the same amount (less a bridge fee) reaching one of your wallets on
          another chain — within an hour, or up to 8 days for full-amount canonical withdrawals.
        </li>
        <li>Wallets you haven&apos;t linked count as other people — link them to exclude those transfers.</li>
        <li>
          Transfers to and from Coinbase, Kraken, Binance and other exchanges are recognised from their public wallets and from
          deposit addresses that forward into them; mark any others yourself under Transfers &amp; exchanges.
        </li>
        <li>
          USD figures use each day&apos;s price, so a trade that gained ETH can still show a USD loss if ETH fell — switch the
          tables to coin view, or see the &ldquo;from trading vs. coin price&rdquo; split.
        </li>
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

