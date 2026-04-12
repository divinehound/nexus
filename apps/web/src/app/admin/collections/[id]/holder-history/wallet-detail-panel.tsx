'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import BalanceLineChart from './balance-line-chart';

type DetailView = 'graph' | 'table';
type HistorySortField = 'blockTimestamp' | 'balanceAfter';
type SortDir = 'asc' | 'desc';

type Props = {
  entries: any[];
  xDomain: [Date, Date];
  chain: string;
};

export default function WalletDetailPanel({ entries, xDomain, chain }: Props) {
  const [view, setView] = useState<DetailView>('graph');
  const [sortField, setSortField] = useState<HistorySortField>('blockTimestamp');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const items = [...entries];
    const mod = sortDir === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      if (sortField === 'blockTimestamp') {
        const at = a.blockTimestamp ? new Date(a.blockTimestamp).getTime() : 0;
        const bt = b.blockTimestamp ? new Date(b.blockTimestamp).getTime() : 0;
        return (at - bt) * mod;
      }
      return ((a.balanceAfter ?? 0) - (b.balanceAfter ?? 0)) * mod;
    });
    return items;
  }, [entries, sortField, sortDir]);

  const handleSort = (field: HistorySortField) => {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('asc'); }
  };

  const copy = (value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedValue(value);
    toast.success('Copied');
    setTimeout(() => setCopiedValue(null), 2000);
  };

  const txExplorerUrl = (sig: string) => {
    if (chain === 'solana') return `https://solscan.io/tx/${sig}`;
    if (chain === 'ethereum') return `https://etherscan.io/tx/${sig}`;
    if (chain === 'base') return `https://basescan.org/tx/${sig}`;
    if (chain === 'polygon') return `https://polygonscan.com/tx/${sig}`;
    return null;
  };

  const tokenExplorerUrl = (mint: string) => {
    if (chain === 'solana') return `https://solscan.io/token/${mint}`;
    return null;
  };

  const walletExplorerUrl = (addr: string) => {
    if (chain === 'solana') return `https://solscan.io/account/${addr}`;
    if (chain === 'ethereum') return `https://etherscan.io/address/${addr}`;
    if (chain === 'base') return `https://basescan.org/address/${addr}`;
    if (chain === 'polygon') return `https://polygonscan.com/address/${addr}`;
    return null;
  };

  return (
    <div>
      {/* Toggle buttons */}
      <div className="mb-3 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setView('graph')}
          className={`rounded p-1.5 ${view === 'graph' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-white'}`}
          title="Chart view"
        >
          {/* Bar chart icon */}
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setView('table')}
          className={`rounded p-1.5 ${view === 'table' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-white'}`}
          title="Table view"
        >
          {/* Table icon */}
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0112 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M12 10.875v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125M12 12h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125M21 12c0 .621-.504 1.125-1.125 1.125m-5.25 0c.621 0 1.125.504 1.125 1.125m-12.75 0c.621 0 1.125.504 1.125 1.125m-2.25 0c-.621 0-1.125.504-1.125 1.125" />
          </svg>
        </button>
      </div>

      {view === 'graph' && (
        <BalanceLineChart entries={entries} xDomain={xDomain} />
      )}

      {view === 'table' && (
        <div className="max-h-[400px] overflow-auto rounded border border-gray-800">
          <table className="min-w-full text-xs">
            <thead className="sticky top-0 bg-gray-900">
              <tr className="text-left uppercase tracking-wide text-gray-500">
                <th className="px-2 py-2">
                  <SortBtn label="Timestamp" field="blockTimestamp" active={sortField} dir={sortDir} onSort={handleSort} />
                </th>
                <th className="px-2 py-2">Token</th>
                <th className="px-2 py-2">From</th>
                <th className="px-2 py-2">To</th>
                <th className="px-2 py-2">
                  <SortBtn label="Balance" field="balanceAfter" active={sortField} dir={sortDir} onSort={handleSort} />
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((e: any, i: number) => {
                const sig = e.transactionHash || '';
                const isSynthetic = sig.startsWith('das-mint:');
                const txUrl = !isSynthetic ? txExplorerUrl(sig) : null;
                const tokenUrl = tokenExplorerUrl(e.tokenId);
                const fromUrl = e.counterpartyAddress && e.direction === 'in' ? walletExplorerUrl(e.counterpartyAddress) : null;
                const toUrl = e.counterpartyAddress && e.direction === 'out' ? walletExplorerUrl(e.counterpartyAddress) : null;
                const fromAddr = e.direction === 'in' ? e.counterpartyAddress || '' : e.address;
                const toAddr = e.direction === 'out' ? e.counterpartyAddress || '' : e.address;

                return (
                  <tr key={`${sig}-${e.logIndex}-${i}`} className="border-t border-gray-800 hover:bg-gray-900/40">
                    {/* Timestamp */}
                    <td className="whitespace-nowrap px-2 py-1.5 text-gray-300">
                      <span
                        className="cursor-help"
                        title={`Tx: ${sig}\nBlock: ${e.blockNumber || '—'}`}
                      >
                        {e.blockTimestamp ? new Date(e.blockTimestamp).toLocaleString() : '—'}
                      </span>
                      {txUrl && (
                        <a href={txUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-gray-600 hover:text-purple-400" title="View on explorer">↗</a>
                      )}
                    </td>

                    {/* Token ID */}
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        <span className="font-mono text-gray-300" title={e.tokenId}>
                          {abbr(e.tokenId)}
                        </span>
                        <CopyBtn value={e.tokenId} copied={copiedValue} onCopy={copy} />
                        {tokenUrl && (
                          <a href={tokenUrl} target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:text-purple-400">↗</a>
                        )}
                      </div>
                    </td>

                    {/* From */}
                    <td className="px-2 py-1.5">
                      {fromAddr ? (
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-gray-400" title={fromAddr}>
                            {abbr(fromAddr)}
                          </span>
                          <CopyBtn value={fromAddr} copied={copiedValue} onCopy={copy} />
                        </div>
                      ) : (
                        <span className="text-gray-600">mint</span>
                      )}
                    </td>

                    {/* To */}
                    <td className="px-2 py-1.5">
                      {toAddr ? (
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-gray-400" title={toAddr}>
                            {abbr(toAddr)}
                          </span>
                          <CopyBtn value={toAddr} copied={copiedValue} onCopy={copy} />
                        </div>
                      ) : (
                        <span className="text-gray-600">burn</span>
                      )}
                    </td>

                    {/* Balance */}
                    <td className="px-2 py-1.5 font-semibold text-purple-300">
                      {e.balanceAfter}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SortBtn({ label, field, active, dir, onSort }: {
  label: string;
  field: HistorySortField;
  active: HistorySortField;
  dir: SortDir;
  onSort: (f: HistorySortField) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className="flex items-center gap-1 text-left text-xs uppercase tracking-wide text-gray-500 hover:text-white"
    >
      {label}
      <span className="text-[10px]">{active === field ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </button>
  );
}

function CopyBtn({ value, copied, onCopy }: { value: string; copied: string | null; onCopy: (v: string) => void }) {
  if (!value) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onCopy(value); }}
      className="text-gray-600 hover:text-white"
      title="Copy"
    >
      {copied === value ? (
        <svg className="h-3 w-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
        </svg>
      )}
    </button>
  );
}

function abbr(s: string | null | undefined): string {
  if (!s) return '';
  if (s.length <= 12) return s;
  return `${s.substring(0, 4)}...${s.substring(s.length - 4)}`;
}
