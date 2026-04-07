'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/context/auth-context';
import { adminGetCollectionHolderHistory, adminScanCollectionHolderHistory } from '@/lib/api';

export default function AdminCollectionHolderHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { accessToken } = useAuth();
  const [collectionId, setCollectionId] = useState<string>('');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState<string>('');
  const [fromBlock, setFromBlock] = useState('');

  useEffect(() => {
    params.then((p) => setCollectionId(p.id));
  }, [params]);

  const load = async () => {
    if (!accessToken || !collectionId) return;
    setLoading(true);
    try {
      const result = await adminGetCollectionHolderHistory(collectionId, accessToken);
      setData(result);
      setSelectedWallet((prev) => prev || result.summary.wallets[0]?.address || '');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to load holder history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [accessToken, collectionId]);

  const walletHistory = useMemo(() => {
    if (!data || !selectedWallet) return [];
    return data.balanceHistory.filter((entry: any) => entry.address === selectedWallet);
  }, [data, selectedWallet]);

  const scan = async () => {
    if (!accessToken || !collectionId) return;
    setScanning(true);
    try {
      const result = await adminScanCollectionHolderHistory(
        collectionId,
        accessToken,
        fromBlock.trim() ? Number(fromBlock) : undefined,
      );
      toast.success(`Processed ${result.processedTransfers.toLocaleString()} transfers`);
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to scan holder history');
    } finally {
      setScanning(false);
    }
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

      <div className="grid gap-6 xl:grid-cols-[1.2fr,0.8fr]">
        <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-5">
          <h2 className="text-lg font-semibold text-white">Wallets by balance</h2>
          <p className="mt-1 text-sm text-gray-400">Sorted descending by current token balance.</p>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-3 pr-4">Wallet</th>
                  <th className="py-3 pr-4">Balance</th>
                  <th className="py-3 pr-4">First received</th>
                  <th className="py-3 pr-4">Last received</th>
                </tr>
              </thead>
              <tbody>
                {data?.summary?.wallets?.map((wallet: any) => (
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
