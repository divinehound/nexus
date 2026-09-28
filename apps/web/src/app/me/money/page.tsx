'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type {
  CashflowCategory,
  CashflowMonth,
  CashflowPosition,
  CashflowReport,
  CashflowResponse,
} from '@nexus/types';
import { AuthGate } from '@/components/wallet/auth-gate';
import { ErrorBoundary } from '@/components/error-boundary';
import { useAuth } from '@/context/auth-context';
import { getMyCashflow } from '@/lib/api';
import { cn, truncateAddress } from '@/lib/utils';
import { CashflowActionsProvider } from './actions';
import { ActivityList } from './activity-list';
import { CashflowChart, IN_COLOR, OUT_COLOR } from './cashflow-chart';
import { CounterpartiesTable } from './counterparties';
import { NftItemsTable } from './nft-items';
import { AfterGas, Dual, Stat } from './ui';
import {
  CATEGORY_LABELS,
  CHAIN_LABELS,
  IN_CATEGORIES,
  OUT_CATEGORIES,
  addressExplorerUrl,
  explorerName,
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
  /** Linked address to report on alone; null = all wallets. */
  const [wallet, setWallet] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      if (!accessToken) return;
      try {
        setError(null);
        setResponse(await getMyCashflow(accessToken, refresh, wallet));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load your money dashboard');
      } finally {
        setSwitching(false);
      }
    },
    [accessToken, wallet],
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
    response?.status === 'ready'
      ? response.report
      : response && 'previous' in response
        ? response.previous
        : null;
  const computing = response?.status === 'computing';

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Money</h1>
          <p className="mt-1 text-sm text-gray-400">
            What came in, what went out, and whether your trades made money — across all your linked
            wallets.
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

      {error && (
        <div className="mb-6 rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {!response && !error && <p className="text-sm text-gray-400">Loading…</p>}

      {response?.status === 'no_wallets' && (
        <div className="rounded-xl border border-gray-800 p-8 text-center">
          <p className="text-gray-300">Link a wallet to see where your money went.</p>
          <Link
            href="/me"
            className="mt-4 inline-block rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500"
          >
            Link a wallet
          </Link>
        </div>
      )}

      {computing && (
        <div
          className="mb-6 flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900/50 p-4 text-sm text-gray-300"
          role="status"
        >
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-600 border-t-purple-400" />
          <span>
            {response.progress}
            <span className="ml-2 text-gray-500">
              Reading your full on-chain history — active wallets can take a few minutes.
            </span>
          </span>
        </div>
      )}

      {response?.status === 'failed' && (
        <div className="mb-6 rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
          Couldn&apos;t build your report: {response.error}
        </div>
      )}

      {report && (
        <CashflowActionsProvider token={accessToken} wallet={wallet} onResponse={setResponse}>
          <Dashboard
            report={report}
            wallet={wallet}
            switching={switching}
            onWalletChange={(w) => {
              setSwitching(true);
              setWallet(w);
            }}
          />
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
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1))
    .toISOString()
    .slice(0, 7);
  return months.filter((m) => m.month >= start);
}

/** Linked wallets for the filter; an EVM address is one wallet across every EVM chain. */
function walletOptions(report: CashflowReport): Array<{ address: string; label: string }> {
  const seen = new Map<string, { address: string; label: string }>();
  for (const w of report.wallets) {
    const evm = w.chain !== 'solana';
    const key = evm ? w.address.toLowerCase() : w.address;
    if (seen.has(key)) continue;
    seen.set(key, {
      address: key,
      label: `${truncateAddress(w.address)} · ${evm ? 'EVM' : 'Solana'}`,
    });
  }
  return [...seen.values()];
}

function WalletFilter({
  report,
  wallet,
  switching,
  onChange,
}: {
  report: CashflowReport;
  wallet: string | null;
  switching: boolean;
  onChange: (w: string | null) => void;
}) {
  const options = walletOptions(report);
  if (options.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-gray-400">
      Wallet
      <select
        value={wallet ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={switching}
        className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200 disabled:opacity-50"
      >
        <option value="">All wallets ({options.length})</option>
        {options.map((o) => (
          <option key={o.address} value={o.address}>
            {o.label}
          </option>
        ))}
      </select>
      {switching && (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-600 border-t-purple-400" />
      )}
    </label>
  );
}

/** How much of the filtered wallet's history was read, per chain — to tell "missing" from "not scanned". */
const STAT_LABELS: Record<string, string> = {
  transactions: 'transactions',
  transfers: 'transfer records',
  nftLegs: 'NFT moves',
  nftCollections: 'NFT collections',
  nftsFromEvents: 'NFTs from sale/mint events (compressed/Core)',
  tokenLegs: 'token moves',
  nativeLegs: 'coin transfers',
  escrowPayments: 'payments from bid escrow',
  balanceChecks: 'balance checks',
  inferredPayments: 'payments found by balance check',
  dasRequested: 'metadata lookups',
  dasResolved: 'metadata found',
  dasFailedBatches: 'failed metadata batches',
};

function ScanCoverage({ report }: { report: CashflowReport }) {
  const rows = report.coverage.filter((c) => c.transfers > 0 || c.truncated || c.error);
  if (rows.length === 0) return null;
  return (
    <div className="-mt-3 text-xs text-gray-500">
      <p>
        Scanned:{' '}
        {rows.map((c, i) => (
          <span key={`${c.chain}:${c.address}`}>
            {i > 0 && ' · '}
            {CHAIN_LABELS[c.chain] ?? c.chain} {c.transfers.toLocaleString()} records
            {c.truncated && (
              <span className="text-yellow-500"> (limit reached — oldest not scanned)</span>
            )}
            {c.error && <span className="text-red-400"> (failed: {c.error.slice(0, 80)})</span>}
          </span>
        ))}
      </p>
      {rows.some((c) => c.stats) && (
        <details className="mt-1">
          <summary className="cursor-pointer text-gray-400 hover:text-white">
            Scan diagnostics
          </summary>
          <p className="mt-1 text-gray-500">
            What the scanner found for this wallet — share this if something looks missing.
          </p>
          <table className="mt-1">
            <tbody>
              {rows
                .filter((c) => c.stats)
                .flatMap((c) =>
                  Object.entries(c.stats ?? {})
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => (
                      <tr key={`${c.chain}:${k}`}>
                        <td className="pr-3 text-gray-400">{CHAIN_LABELS[c.chain] ?? c.chain}</td>
                        <td className="pr-3">{STAT_LABELS[k] ?? k}</td>
                        <td className="tabular-nums text-gray-300">{v.toLocaleString()}</td>
                      </tr>
                    )),
                )}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function Dashboard({
  report,
  wallet,
  switching,
  onWalletChange,
}: {
  report: CashflowReport;
  wallet: string | null;
  switching: boolean;
  onWalletChange: (w: string | null) => void;
}) {
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
      for (const [k, v] of Object.entries(m.byCategory) as Array<[CashflowCategory, number]>)
        byCategory[k] = (byCategory[k] ?? 0) + v;
    }
    const netInvested = (byCategory.exchange_withdrawal ?? 0) - (byCategory.exchange_deposit ?? 0);
    return {
      inUsd,
      outUsd,
      feesUsd,
      realized,
      realizedAfterGas,
      net: inUsd - outUsd,
      netInvested,
      byCategory,
    };
  }, [months]);

  if (report.totals.txCount === 0) {
    return (
      <div className="space-y-4">
        <div className="flex justify-end">
          <WalletFilter
            report={report}
            wallet={wallet}
            switching={switching}
            onChange={onWalletChange}
          />
        </div>
        <div className="rounded-xl border border-gray-800 p-8 text-center text-gray-400">
          No transactions found yet for{' '}
          {report.walletFilter ? 'this wallet' : 'your linked wallets'}.
          <Coverage report={report} />
        </div>
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
              range === r.id
                ? 'bg-purple-500/15 text-purple-300'
                : 'text-gray-400 hover:bg-gray-800 hover:text-white',
            )}
          >
            {r.label}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <WalletFilter
            report={report}
            wallet={wallet}
            switching={switching}
            onChange={onWalletChange}
          />
          <span className="text-xs text-gray-500">
            {report.totals.txCount.toLocaleString()} transactions
            {report.walletFilter ? ' in this wallet' : ''}
          </span>
        </div>
      </div>
      {report.walletFilter && <ScanCoverage report={report} />}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Money in" value={usd(totals.inUsd)} swatch={IN_COLOR} />
        <Stat label="Money out" value={usd(totals.outUsd)} swatch={OUT_COLOR} />
        <Stat
          label="Net cash flow"
          value={usdSigned(totals.net)}
          valueClass={pnlClass(totals.net)}
        />
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
        {months.length > 0 ? (
          <CashflowChart months={months} />
        ) : (
          <p className="text-sm text-gray-500">No activity in this range.</p>
        )}
        {months.length > 0 && <MonthTable months={months} />}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <Breakdown
          title="Where your money went"
          categories={OUT_CATEGORIES}
          byCategory={totals.byCategory}
          total={totals.outUsd}
          color={OUT_COLOR}
        />
        <Breakdown
          title="Where your money came from"
          categories={IN_CATEGORIES}
          byCategory={totals.byCategory}
          total={totals.inUsd}
          color={IN_COLOR}
        />
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
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-xs text-gray-400 hover:text-white"
        aria-expanded={open}
      >
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
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-400">
                    {usd(m.feesUsd)}
                  </td>
                  <td
                    className={cn(
                      'py-2 pr-4 text-right tabular-nums',
                      pnlClass(m.inUsd - m.outUsd),
                    )}
                  >
                    {usdSigned(m.inUsd - m.outUsd)}
                  </td>
                  <td
                    className={cn('py-2 pr-4 text-right tabular-nums', pnlClass(m.realizedPnlUsd))}
                  >
                    {usdSigned(m.realizedPnlUsd)}
                  </td>
                  <td
                    className={cn(
                      'py-2 text-right tabular-nums',
                      pnlClass(m.realizedPnlAfterGasUsd),
                    )}
                  >
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
                <span className="ml-2 text-xs text-gray-500">
                  {total > 0 ? `${Math.round((v / total) * 100)}%` : '—'}
                </span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-gray-800/60">
              {v > 0 && (
                <div
                  className="h-2 rounded-full"
                  style={{ width: `${Math.max((v / max) * 100, 1)}%`, background: color }}
                />
              )}
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
              tab === t.id
                ? 'border-purple-400 text-white'
                : 'border-transparent text-gray-400 hover:text-white',
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

function ContractLink({ chain, contract }: { chain: string; contract: string }) {
  const url = contract ? addressExplorerUrl(chain, contract) : null;
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="ml-5 text-[11px] text-gray-500 underline-offset-2 hover:text-purple-300 hover:underline"
    >
      {chain === 'solana' ? 'collection' : 'contract'} on {explorerName(chain)} ↗
    </a>
  );
}

/** Sum a native-coin field per symbol and format as "+0.4 ETH · −12 SOL". */
function perSymbol(
  rows: CashflowPosition[],
  pick: (r: CashflowPosition) => number,
  signed: boolean,
): string {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r.nativeSymbol, (sums.get(r.nativeSymbol) ?? 0) + pick(r));
  const parts = [...sums.entries()]
    .filter(([, v]) => Math.abs(v) > 1e-9)
    .map(([sym, v]) => nativeAmount(v, sym, signed));
  return parts.length ? parts.join(' · ') : '';
}

function PositionsTable({ rows, kind }: { rows: CashflowPosition[]; kind: 'nft' | 'fungible' }) {
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Spam airdrops never involve money — hide them unless asked.
  // Anything actually bought or sold — including on days with no USD price.
  // Anything bought, sold or minted (free mints included — spam airdrops come
  // from other addresses, not the zero address, so they stay tucked away).
  const traded = rows.filter(
    (r) =>
      r.buyCount > 0 ||
      r.sellCount > 0 ||
      r.spentUsd > 0 ||
      r.proceedsUsd > 0 ||
      r.items.some((i) => i.acquiredVia === 'mint' || i.acquiredVia === 'free_mint'),
  );
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
      sellsUsd: acc.sellsUsd + r.sellCountUsd,
    }),
    {
      spent: 0,
      proceeds: 0,
      pnl: 0,
      pnlAfterGas: 0,
      tradeGain: 0,
      priceMove: 0,
      gas: 0,
      open: 0,
      sellsUsd: 0,
    },
  );
  const qtyUnit = kind === 'nft' ? 'items' : 'amount';
  const pnlNative = perSymbol(traded, (r) => r.realizedPnlNative, true);
  const pnlAfterGasNative = perSymbol(traded, (r) => r.realizedPnlAfterGasNative, true);

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat
          label="Total spent"
          value={usd(totals.spent)}
          sub={perSymbol(traded, (r) => r.spentNative, false)}
        />
        <Stat
          label="Total sold for"
          value={usd(totals.proceeds)}
          sub={perSymbol(traded, (r) => r.proceedsNative, false)}
        />
        <Stat
          label="Realized profit / loss"
          // No sale had a USD price: the USD result is unknown, not zero.
          value={totals.sellsUsd > 0 ? usdSigned(totals.pnl) : '—'}
          valueClass={totals.sellsUsd > 0 ? pnlClass(totals.pnl) : undefined}
          sub={
            <>
              {pnlNative && <div className="text-gray-300">{pnlNative}</div>}
              {totals.sellsUsd > 0 && <AfterGas value={totals.pnlAfterGas} />}
              {pnlAfterGasNative && (
                <span className="text-gray-300">
                  {totals.sellsUsd > 0 ? ' · ' : 'after gas '}
                  {pnlAfterGasNative}
                </span>
              )}
            </>
          }
        />
        <Stat
          label="From trading vs. coin price"
          value={totals.sellsUsd > 0 ? usdSigned(totals.tradeGain) : '—'}
          valueClass={totals.sellsUsd > 0 ? pnlClass(totals.tradeGain) : undefined}
          sub={
            totals.sellsUsd > 0 ? (
              <>
                coin price moved{' '}
                <span className={cn('tabular-nums', pnlClass(totals.priceMove))}>
                  {usdSigned(totals.priceMove)}
                </span>
              </>
            ) : (
              'needs USD prices for the sales'
            )
          }
        />
        <Stat
          label="Cost of what you still hold"
          value={usd(totals.open)}
          sub={`${usd(totals.gas)} gas spent in total`}
        />
      </div>
      <p className="mb-3 text-xs text-gray-500">
        Each amount shows USD (at that day&apos;s price) and, underneath, the chain&apos;s own coin
        — cost at the buy-day rate, proceeds at the sale-day rate. They can disagree: a trade that
        made ETH still loses USD if ETH fell while you held. &ldquo;From trading&rdquo; is your coin
        profit valued at the sale-day price; &ldquo;coin price moved&rdquo; is the rest.
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
              <th
                className="py-2 pr-4 text-right font-medium"
                title="Sale proceeds (after marketplace fees and royalties) minus what you paid"
              >
                Realized P/L
              </th>
              <th
                className="py-2 pr-4 text-right font-medium"
                title="Also subtracts gas paid to buy or mint what you sold, and gas paid to sell it"
              >
                P/L after gas
              </th>
              <th className="py-2 text-right font-medium">Still held</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/70">
            {visible.map((r) => (
              <Fragment key={r.key}>
                <tr className="align-top">
                  <td className="py-2 pr-4">
                    {kind === 'nft' && r.items.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => toggle(r.key)}
                        aria-expanded={expanded.has(r.key)}
                        className="group flex items-start gap-1.5 text-left"
                      >
                        <span
                          className={cn(
                            'mt-0.5 text-xs text-gray-500 transition-transform',
                            expanded.has(r.key) && 'rotate-90',
                          )}
                          aria-hidden="true"
                        >
                          ▶
                        </span>
                        <span>
                          <span className="font-medium text-gray-200 group-hover:text-purple-300">
                            {r.name}
                          </span>
                          <span className="block text-xs text-gray-500">
                            {CHAIN_LABELS[r.chain] ?? r.chain} ·{' '}
                            {expanded.has(r.key) ? 'hide' : 'show'} {r.items.length} item
                            {r.items.length === 1 ? '' : 's'}
                          </span>
                        </span>
                      </button>
                    ) : (
                      <>
                        <div className="font-medium text-gray-200">{r.name}</div>
                        <div className="text-xs text-gray-500">
                          {CHAIN_LABELS[r.chain] ?? r.chain}
                          {r.symbol && kind === 'fungible' && r.symbol !== r.name
                            ? ` · ${r.symbol}`
                            : ''}
                        </div>
                      </>
                    )}
                    <ContractLink chain={r.chain} contract={r.contract} />
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-300">
                    {r.qtyBought ? qty(r.qtyBought) : '—'}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {r.spentUsd || r.spentNative ? (
                      <Dual
                        usd={r.spentUsd || null}
                        native={r.spentNative}
                        symbol={r.nativeSymbol}
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-300">
                    {r.qtySold ? qty(r.qtySold) : '—'}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {r.proceedsUsd || r.proceedsNative ? (
                      <Dual
                        usd={r.proceedsUsd || null}
                        native={r.proceedsNative}
                        symbol={r.nativeSymbol}
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {r.sellCount > 0 ? (
                      <>
                        <Dual
                          usd={r.sellCountUsd > 0 ? r.realizedPnlUsd : null}
                          native={r.realizedPnlNative}
                          symbol={r.nativeSymbol}
                          signed
                        />
                        {r.usdPriceMissing > 0 && (
                          <div
                            className="cursor-help text-xs text-yellow-500"
                            title={`${r.usdPriceMissing} buy/sale${r.usdPriceMissing === 1 ? '' : 's'} happened on days with no USD price. They're included in the ${r.nativeSymbol} figures but left out of the USD ones.`}
                          >
                            {r.usdPriceMissing} trade{r.usdPriceMissing === 1 ? '' : 's'} in{' '}
                            {r.nativeSymbol} only
                          </div>
                        )}
                        {r.qtySoldWithoutBasis > 0 && (
                          <span
                            className="cursor-help text-xs text-yellow-500"
                            title={`${qty(r.qtySoldWithoutBasis)} sold without a recorded purchase (airdrop, gift, or older than the scanned history) — counted at $0 cost.`}
                          >
                            * some at $0 cost
                          </span>
                        )}
                        {Math.abs(r.priceMoveUsd) >= 1 && (
                          <div className="text-xs text-gray-500">
                            trade {usdSigned(r.tradeGainUsd)} · {r.nativeSymbol} price{' '}
                            {usdSigned(r.priceMoveUsd)}
                          </div>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {r.sellCount > 0 ? (
                      <Dual
                        usd={r.sellCountUsd > 0 ? r.realizedPnlAfterGasUsd : null}
                        native={r.realizedPnlAfterGasNative}
                        symbol={r.nativeSymbol}
                        signed
                      />
                    ) : (
                      '—'
                    )}
                    {r.gasUsd > 0 && (
                      <div className="text-xs text-gray-500">{usd(r.gasUsd)} total gas</div>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums text-gray-300">
                    {r.qtyHeld > 0 ? qty(r.qtyHeld) : '—'}
                    {r.openCostBasisUsd > 0 && (
                      <div className="text-xs text-gray-500">cost {usd(r.openCostBasisUsd)}</div>
                    )}
                  </td>
                </tr>
                {expanded.has(r.key) && (
                  <tr>
                    <td colSpan={8} className="pb-4">
                      <NftItemsTable position={r} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-gray-500">
                  No {kind === 'nft' ? 'NFT' : 'token'} buys or sales found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > traded.length && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="mt-3 text-xs text-gray-400 hover:text-white"
        >
          {showAll ? 'Hide' : 'Show'} {rows.length - traded.length} with no money involved
          (airdrops, free mints, spam)
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
              <td className="py-2 text-right tabular-nums text-gray-400">
                {usd(f.txCount ? f.feesUsd / f.txCount : 0)}
              </td>
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
        <li>
          Money in/out counts native coins (ETH, SOL, POL, APE), their wrapped versions, and USD
          stablecoins, valued at that day&apos;s price.
        </li>
        <li>
          Profit/loss per NFT is what you actually received for it — after marketplace fees and
          royalties — minus what you paid for that exact token; tokens use average cost. &ldquo;P/L
          after gas&rdquo; also subtracts the gas you paid to buy or mint the items you sold and the
          gas on the sale; gas for items you still hold waits until you sell them.
        </li>
        <li>Swaps between two coins count as conversions, not spending.</li>
        <li>
          Moves between your own linked wallets are never counted twice: same-chain transfers are
          dropped, and a bridge is recognised by pairing money leaving one chain with the same
          amount (less a bridge fee) reaching one of your wallets on another chain — within an hour,
          or up to 8 days for full-amount canonical withdrawals.
        </li>
        <li>
          Wallets you haven&apos;t linked count as other people — link them to exclude those
          transfers.
        </li>
        <li>
          Transfers to and from Coinbase, Kraken, Binance and other exchanges are recognised from
          their public wallets and from deposit addresses that forward into them; mark any others
          yourself under Transfers &amp; exchanges.
        </li>
        <li>
          USD figures use each day&apos;s price, so a trade that gained ETH can still show a USD
          loss if ETH fell — switch the tables to coin view, or see the &ldquo;from trading vs. coin
          price&rdquo; split.
        </li>
        {report.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      {failed.length > 0 && (
        <div className="mt-3 text-yellow-500">
          Couldn&apos;t scan:{' '}
          {failed
            .map((c) => `${CHAIN_LABELS[c.chain] ?? c.chain} ${truncateAddress(c.address)}`)
            .join(', ')}
          . Try Refresh later.
        </div>
      )}
    </details>
  );
}
