'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/context/auth-context';
import { adminGetCollectionHolderHistory, adminGetCollectionHolderHistoryStatus, adminScanCollectionHolderHistory } from '@/lib/api';
import { truncateAddress } from '@/lib/utils';
import BalanceLineChart from './balance-line-chart';

type SortField = 'currentBalance' | 'firstReceivedAt' | 'lastReceivedAt' | 'address';
type SortDirection = 'asc' | 'desc';

const PAGE_SIZE = 50;

export default function AdminCollectionHolderHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { accessToken } = useAuth();
  const [collectionId, setCollectionId] = useState<string>('');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState<string>('');
  const [fromBlock, setFromBlock] = useState('');
  const [jobStatus, setJobStatus] = useState<any>(null);
  const [sortField, setSortField] = useState<SortField>('currentBalance');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [historySortDirection, setHistorySortDirection] = useState<SortDirection>('desc');
  const [page, setPage] = useState(1);
  const [expandedWallet, setExpandedWallet] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  useEffect(() => {
    params.then((p) => setCollectionId(p.id));
  }, [params]);

  const load = async () => {
    if (!accessToken || !collectionId) return;
    setLoading(true);
    try {
      const result = await adminGetCollectionHolderHistory(collectionId, accessToken);
      setData(result);
      setJobStatus(result.scanJob ?? null);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to load holder history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [accessToken, collectionId]);

  const sortedWallets = useMemo(() => {
    const wallets = [...(data?.summary?.wallets ?? [])];
    wallets.sort((a: any, b: any) => compareWallets(a, b, sortField, sortDirection));
    return wallets;
  }, [data, sortField, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedWallets.length / PAGE_SIZE));
  const pagedWallets = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return sortedWallets.slice(start, start + PAGE_SIZE);
  }, [sortedWallets, page]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  useEffect(() => {
    const visibleAddresses = new Set(pagedWallets.map((wallet: any) => wallet.address));
    if (!selectedWallet || !visibleAddresses.has(selectedWallet)) {
      setSelectedWallet(pagedWallets[0]?.address || '');
    }
  }, [pagedWallets, selectedWallet]);

  const walletHistory = useMemo(() => {
    if (!data || !selectedWallet) return [];
    const filtered = data.balanceHistory.filter((entry: any) => entry.address === selectedWallet);
    const modifier = historySortDirection === 'asc' ? 1 : -1;
    return filtered.sort((a: any, b: any) => {
      const aTime = a.blockTimestamp ? new Date(a.blockTimestamp).getTime() : 0;
      const bTime = b.blockTimestamp ? new Date(b.blockTimestamp).getTime() : 0;
      return (aTime - bTime) * modifier;
    });
  }, [data, selectedWallet, historySortDirection]);

  const chartDomains = useMemo(() => {
    const history = data?.balanceHistory ?? [];
    if (history.length === 0) return { xDomain: [new Date(), new Date()] as [Date, Date], yMax: 1 };
    let minTime = Infinity;
    let maxTime = -Infinity;
    let maxBalance = 0;
    for (const e of history) {
      const t = new Date(e.blockTimestamp).getTime();
      if (t < minTime) minTime = t;
      if (t > maxTime) maxTime = t;
      if (e.balanceAfter > maxBalance) maxBalance = e.balanceAfter;
    }
    return { xDomain: [new Date(minTime), new Date(maxTime)] as [Date, Date], yMax: maxBalance };
  }, [data]);

  useEffect(() => {
    if (!accessToken || !collectionId) return;
    if (!jobStatus || !['queued', 'running'].includes(jobStatus.status)) return;

    const interval = setInterval(async () => {
      try {
        const status = await adminGetCollectionHolderHistoryStatus(collectionId, accessToken);
        setJobStatus(status);
        if (status.status === 'completed' || status.status === 'failed') {
          clearInterval(interval);
          await load();
        }
      } catch {
        clearInterval(interval);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [accessToken, collectionId, jobStatus?.status]);

  const scan = async () => {
    if (!accessToken || !collectionId) return;
    setScanning(true);
    try {
      const result = await adminScanCollectionHolderHistory(
        collectionId,
        accessToken,
        fromBlock.trim() ? Number(fromBlock) : undefined,
      );
      setJobStatus(result.job);
      toast.success(result.alreadyRunning ? 'Scan already running' : 'Holder history scan queued');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to scan holder history');
    } finally {
      setScanning(false);
    }
  };

  const handleSort = (field: SortField) => {
    setPage(1);
    if (field === sortField) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortField(field);
    setSortDirection(field === 'address' ? 'asc' : 'desc');
  };

  if (loading) {
    return <div className="p-6 text-sm text-gray-400">Loading holder history...</div>;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-4 rounded-xl border border-gray-800 bg-gray-950/50 p-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Holder history</h1>
          <p className="mt-2 text-sm text-gray-400">
            Full holder summary, first received date, last received date, and wallet balance over time.
          </p>
        </div>
        <div className="flex gap-3">
          <input
            value={fromBlock}
            onChange={(e) => setFromBlock(e.target.value)}
            placeholder={String(data?.collection?.holderHistoryLastCheckedBlock ?? '') || 'Optional from block'}
            className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500"
          />
          <button
            onClick={scan}
            disabled={scanning}
            className="rounded bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50"
          >
            {scanning ? 'Scanning...' : 'Scan / Refresh'}
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Tracked wallets" value={String(data?.summary?.totalWallets ?? 0)} />
        <Stat label="Tokens held" value={String(data?.summary?.totalTokensHeld ?? 0)} />
        <Stat label="Last checked block" value={String(data?.collection?.holderHistoryLastCheckedBlock ?? '—')} />
        <Stat
          label="Last scanned"
          value={data?.collection?.holderHistoryLastScannedAt ? new Date(data.collection.holderHistoryLastScannedAt).toLocaleString() : '—'}
        />
      </div>

      {jobStatus && jobStatus.status !== 'idle' && (
        <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-4 text-sm text-gray-300">
          <div className="flex flex-wrap items-center gap-4">
            <span>Status: <strong className="text-white">{jobStatus.status}</strong></span>
            {jobStatus.fromBlock !== undefined && <span>From: <strong className="text-white">{jobStatus.fromBlock}</strong></span>}
            {jobStatus.toBlock !== undefined && <span>To: <strong className="text-white">{jobStatus.toBlock}</strong></span>}
            {jobStatus.processedTransfers !== undefined && <span>Transfers: <strong className="text-white">{jobStatus.processedTransfers}</strong></span>}
            {jobStatus.touchedWallets !== undefined && <span>Wallets: <strong className="text-white">{jobStatus.touchedWallets}</strong></span>}
          </div>
          {jobStatus.error && <div className="mt-2 text-red-400">{jobStatus.error}</div>}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.2fr,0.8fr]">
        <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Wallets by balance</h2>
              <p className="mt-1 text-sm text-gray-400">Sort by any column and page through holders 50 at a time.</p>
            </div>
            <div className="text-xs text-gray-500">
              Showing {(page - 1) * PAGE_SIZE + (pagedWallets.length > 0 ? 1 : 0)}-
              {(page - 1) * PAGE_SIZE + pagedWallets.length} of {sortedWallets.length}
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="w-8 py-3" />
                  <SortableHeader label="Wallet" field="address" activeField={sortField} direction={sortDirection} onSort={handleSort} />
                  <SortableHeader label="Balance" field="currentBalance" activeField={sortField} direction={sortDirection} onSort={handleSort} />
                  <SortableHeader label="First received" field="firstReceivedAt" activeField={sortField} direction={sortDirection} onSort={handleSort} />
                  <SortableHeader label="Last received" field="lastReceivedAt" activeField={sortField} direction={sortDirection} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {pagedWallets.map((wallet: any) => {
                  const isExpanded = expandedWallet === wallet.address;
                  const chain = data?.collection?.chain ?? '';
                  const explorerUrl = getExplorerLink(chain, wallet.address);
                  return (
                    <WalletRows key={wallet.address}>
                      <tr
                        onClick={() => setSelectedWallet(wallet.address)}
                        className={`cursor-pointer border-b border-gray-900 ${selectedWallet === wallet.address ? 'bg-gray-900/70' : 'hover:bg-gray-900/40'}`}
                      >
                        <td className="w-8 py-3 pl-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedWallet(isExpanded ? null : wallet.address);
                            }}
                            className="flex h-5 w-5 items-center justify-center rounded text-gray-500 hover:text-white"
                          >
                            <svg className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="currentColor" viewBox="0 0 20 20">
                              <path d="M6.293 4.293a1 1 0 011.414 0L14 10.586l-6.293 6.293a1 1 0 01-1.414-1.414L11.172 10.5 6.293 5.707a1 1 0 010-1.414z" />
                            </svg>
                          </button>
                        </td>
                        <td className="py-3 pr-4">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-gray-200" title={wallet.address}>
                              {truncateAddress(wallet.address, 6)}
                            </span>
                            {explorerUrl && (
                              <a
                                href={explorerUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-gray-500 hover:text-purple-400"
                                title="View on explorer"
                              >
                                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                                </svg>
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                navigator.clipboard.writeText(wallet.address);
                                setCopiedAddress(wallet.address);
                                toast.success('Address copied');
                                setTimeout(() => setCopiedAddress(null), 2000);
                              }}
                              className="text-gray-500 hover:text-white"
                              title="Copy address"
                            >
                              {copiedAddress === wallet.address ? (
                                <svg className="h-3.5 w-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                </svg>
                              ) : (
                                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
                                </svg>
                              )}
                            </button>
                          </div>
                        </td>
                        <td className="py-3 pr-4 font-semibold text-purple-300">{wallet.currentBalance}</td>
                        <td className="py-3 pr-4 text-gray-300">{formatDate(wallet.firstReceivedAt)}</td>
                        <td className="py-3 pr-4 text-gray-300">{formatDate(wallet.lastReceivedAt)}</td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={5} className="border-b border-gray-800 bg-gray-950/60 px-4 py-3">
                            <BalanceLineChart
                              entries={(data?.balanceHistory ?? []).filter((e: any) => e.address === wallet.address)}
                              xDomain={chartDomains.xDomain}
                              yMax={chartDomains.yMax}
                            />
                          </td>
                        </tr>
                      )}
                    </WalletRows>
                  );
                })}
              </tbody>
            </table>
            {pagedWallets.length === 0 && <p className="py-6 text-sm text-gray-500">No wallets found yet.</p>}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <button
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              disabled={page <= 1}
              className="rounded border border-gray-700 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous
            </button>
            <div className="text-sm text-gray-400">
              Page {page} of {totalPages}
            </div>
            <button
              onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              disabled={page >= totalPages}
              className="rounded border border-gray-700 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-5">
          <div className="flex items-end justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Balance over time</h2>
              <p className="mt-1 text-sm text-gray-400">Transfer-by-transfer balance checkpoints.</p>
            </div>
            <button
              type="button"
              onClick={() => setHistorySortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
              className="flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:text-white"
            >
              Date {historySortDirection === 'asc' ? '▲' : '▼'}
            </button>
          </div>
          {selectedWallet ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-3 font-mono text-xs text-gray-300">
                {selectedWallet}
              </div>
              <div className="max-h-[560px] space-y-3 overflow-y-auto pr-1">
                {walletHistory.map((entry: any) => (
                  <div key={`${entry.transactionHash}-${entry.logIndex}-${entry.address}`} className="rounded-lg border border-gray-800 bg-gray-900/40 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className={`rounded-full px-2 py-1 text-xs ${entry.direction === 'in' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-rose-900/40 text-rose-300'}`}>
                        {entry.direction.toUpperCase()}
                      </span>
                      <span className="text-xs text-gray-500">Block {entry.blockNumber}</span>
                    </div>
                    <div className="mt-2 text-sm text-white">Balance after: {entry.balanceAfter}</div>
                    <div className="mt-1 text-xs text-gray-400">Token #{entry.tokenId}</div>
                    <div className="mt-1 text-xs text-gray-500">Counterparty: {entry.counterpartyAddress || '—'}</div>
                    <div className="mt-1 text-xs text-gray-500">{new Date(entry.blockTimestamp).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-gray-500">Select a wallet to inspect its history.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SortableHeader({
  label,
  field,
  activeField,
  direction,
  onSort,
}: {
  label: string;
  field: SortField;
  activeField: SortField;
  direction: SortDirection;
  onSort: (field: SortField) => void;
}) {
  const isActive = activeField === field;
  return (
    <th className="py-3 pr-4">
      <button
        type="button"
        onClick={() => onSort(field)}
        className="flex items-center gap-1 text-left text-xs uppercase tracking-wide text-gray-500 hover:text-white"
      >
        <span>{label}</span>
        <span className="text-[10px]">{isActive ? (direction === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}

function compareWallets(a: any, b: any, field: SortField, direction: SortDirection) {
  const modifier = direction === 'asc' ? 1 : -1;

  if (field === 'address') {
    return a.address.localeCompare(b.address) * modifier;
  }

  if (field === 'currentBalance') {
    return ((a.currentBalance ?? 0) - (b.currentBalance ?? 0)) * modifier;
  }

  const aValue = a[field] ? new Date(a[field]).getTime() : 0;
  const bValue = b[field] ? new Date(b[field]).getTime() : 0;
  return (aValue - bValue) * modifier;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-2 text-lg font-semibold text-white">{value}</div>
    </div>
  );
}

function formatDate(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function WalletRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function getExplorerLink(chain: string, address: string): string | null {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return `https://etherscan.io/address/${address}`;
  if (c === 'base') return `https://basescan.org/address/${address}`;
  if (c === 'polygon') return `https://polygonscan.com/address/${address}`;
  if (c === 'abstract') return `https://explorer.abs.xyz/address/${address}`;
  if (c === 'apechain') return `https://apescan.io/address/${address}`;
  if (c === 'solana') return `https://solscan.io/account/${address}`;
  return null;
}
