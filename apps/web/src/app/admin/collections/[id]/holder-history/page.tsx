'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/context/auth-context';
import { adminGetCollectionHolderHistory, adminGetCollectionHolderHistoryStatus, adminScanCollectionHolderHistory } from '@/lib/api';

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
  const [page, setPage] = useState(1);

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
    return data.balanceHistory.filter((entry: any) => entry.address === selectedWallet);
  }, [data, selectedWallet]);

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
                  <SortableHeader label="Wallet" field="address" activeField={sortField} direction={sortDirection} onSort={handleSort} />
                  <SortableHeader label="Balance" field="currentBalance" activeField={sortField} direction={sortDirection} onSort={handleSort} />
                  <SortableHeader label="First received" field="firstReceivedAt" activeField={sortField} direction={sortDirection} onSort={handleSort} />
                  <SortableHeader label="Last received" field="lastReceivedAt" activeField={sortField} direction={sortDirection} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {pagedWallets.map((wallet: any) => (
                  <tr
                    key={wallet.address}
                    onClick={() => setSelectedWallet(wallet.address)}
                    className={`cursor-pointer border-b border-gray-900 ${selectedWallet === wallet.address ? 'bg-gray-900/70' : 'hover:bg-gray-900/40'}`}
                  >
                    <td className="py-3 pr-4 font-mono text-xs text-gray-200">{wallet.address}</td>
                    <td className="py-3 pr-4 font-semibold text-purple-300">{wallet.currentBalance}</td>
                    <td className="py-3 pr-4 text-gray-300">{formatDate(wallet.firstReceivedAt)}</td>
                    <td className="py-3 pr-4 text-gray-300">{formatDate(wallet.lastReceivedAt)}</td>
                  </tr>
                ))}
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
          <h2 className="text-lg font-semibold text-white">Balance over time</h2>
          <p className="mt-1 text-sm text-gray-400">Transfer-by-transfer balance checkpoints.</p>
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
