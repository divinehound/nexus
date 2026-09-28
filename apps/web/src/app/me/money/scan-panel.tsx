'use client';

import { useState } from 'react';
import type { CashflowReport, CashflowWalletChains } from '@nexus/types';
import { refreshCashflow, setCashflowWalletChains } from '@/lib/api';
import { cn, truncateAddress } from '@/lib/utils';
import { useCashflowActions } from './actions';
import { CHAIN_LABELS, relativeTime } from './format';

const targetKey = (chain: string, address: string) => `${chain}:${address}`;

/**
 * Scans are saved per wallet and chain. This picks which EVM chains each
 * wallet is scanned on, and rescans just the wallets/chains chosen.
 */
export function ScanPanel({
  report,
  computing,
  onClose,
}: {
  report: CashflowReport;
  computing: boolean;
  onClose: () => void;
}) {
  const { run, busy } = useCashflowActions();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const disabled = busy || computing;

  const rescan = (
    targets: Array<{ chain: string; address: string }> | undefined,
    mode: 'full' | 'new',
  ) => {
    const what = targets
      ? `${targets.length} wallet/chain${targets.length === 1 ? '' : 's'}`
      : 'everything';
    return void run(
      mode === 'new' ? `Fetching new activity for ${what}…` : `Rescanning ${what} from scratch…`,
      (t, view) => refreshCashflow(t, targets, view, mode),
    ).then((ok) => {
      if (ok) {
        setSelected(new Set());
        onClose();
      }
    });
  };
  const selectedTargets = () =>
    [...selected].map((k) => {
      const i = k.indexOf(':');
      return { chain: k.slice(0, i), address: k.slice(i + 1) };
    });

  return (
    <section className="mb-6 rounded-xl border border-gray-800 p-4 text-sm">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-semibold text-gray-200">Scans</h2>
        <span className="text-xs text-gray-500">
          Scans are saved — reloading the page doesn&apos;t rescan. <b>Fetch new</b> reads only what
          happened since each one&apos;s last scan; <b>Full rescan</b> re-reads its whole history
          (use it after a fix, or if something looks missing).
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-xs text-gray-400 hover:text-white"
        >
          Close
        </button>
      </div>
      <div className="space-y-4">
        {report.walletChains.map((w) => (
          <WalletScans
            key={w.address}
            wallet={w}
            report={report}
            selected={selected}
            onToggle={toggle}
            disabled={disabled}
          />
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">Selected ({selected.size}):</span>
        <button
          type="button"
          disabled={disabled || selected.size === 0}
          onClick={() => rescan(selectedTargets(), 'new')}
          className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Fetch new
        </button>
        <button
          type="button"
          disabled={disabled || selected.size === 0}
          onClick={() => rescan(selectedTargets(), 'full')}
          className="rounded-lg border border-purple-600/60 px-3 py-1.5 text-xs font-medium text-purple-200 hover:bg-purple-600/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Full rescan
        </button>
        <span className="ml-2 text-xs text-gray-500">Everything:</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => rescan(undefined, 'new')}
          className="rounded-lg px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 hover:text-white disabled:opacity-50"
        >
          Fetch new
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (
              window.confirm(
                'Re-read every wallet on every chain from scratch? Active wallets can take several minutes.',
              )
            )
              rescan(undefined, 'full');
          }}
          className="rounded-lg px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 hover:text-white disabled:opacity-50"
        >
          Full rescan
        </button>
        {computing && <span className="text-xs text-gray-500">A scan is running…</span>}
      </div>
    </section>
  );
}

function WalletScans({
  wallet,
  report,
  selected,
  onToggle,
  disabled,
}: {
  wallet: CashflowWalletChains;
  report: CashflowReport;
  selected: Set<string>;
  onToggle: (key: string) => void;
  disabled: boolean;
}) {
  const { run } = useCashflowActions();
  const [chains, setChains] = useState<string[]>(wallet.chains);
  const dirty =
    chains.length !== wallet.chains.length || chains.some((c) => !wallet.chains.includes(c));
  const scans = report.scans.filter((s) => s.address === wallet.address);
  const allSelected = wallet.chains.every((c) => selected.has(targetKey(c, wallet.address)));

  return (
    <div className="rounded-lg border border-gray-800/70 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-gray-200">{truncateAddress(wallet.address)}</span>
        <span className="text-xs text-gray-500">{wallet.family === 'evm' ? 'EVM' : 'Solana'}</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            for (const c of wallet.chains) {
              const key = targetKey(c, wallet.address);
              if (allSelected === selected.has(key)) onToggle(key);
            }
          }}
          className="ml-auto text-xs text-gray-400 hover:text-white disabled:opacity-50"
        >
          {allSelected ? 'Unselect all' : 'Select all for rescan'}
        </button>
      </div>

      {wallet.family === 'evm' && (
        <div className="mb-3">
          <div className="mb-1 text-xs text-gray-500">
            Chains to scan{' '}
            {!wallet.custom && <span>(all by default — untick chains this wallet never uses)</span>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {report.availableChains.map((c) => {
              const on = chains.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => setChains(on ? chains.filter((x) => x !== c) : [...chains, c])}
                  className={cn(
                    'rounded-md border px-2 py-0.5 text-xs transition-colors disabled:opacity-50',
                    on
                      ? 'border-purple-500/50 bg-purple-500/15 text-purple-200'
                      : 'border-gray-700 text-gray-500 hover:text-gray-300',
                  )}
                >
                  {on ? '✓ ' : ''}
                  {CHAIN_LABELS[c] ?? c}
                </button>
              );
            })}
          </div>
          {dirty && (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <button
                type="button"
                disabled={disabled || chains.length === 0}
                onClick={() =>
                  void run('Chains saved — scanning any newly added ones', (t, view) =>
                    setCashflowWalletChains(t, wallet.address, chains, view),
                  )
                }
                className="rounded-md bg-purple-600 px-2 py-1 text-white hover:bg-purple-500 disabled:opacity-50"
              >
                Save chains
              </button>
              <button
                type="button"
                onClick={() => setChains(wallet.chains)}
                className="text-gray-400 hover:text-white"
              >
                Undo
              </button>
              <span className="text-gray-500">
                Unticked chains&apos; saved scans are dropped; newly ticked ones are scanned.
              </span>
            </div>
          )}
        </div>
      )}

      <table className="w-full text-xs">
        <thead className="text-left text-gray-500">
          <tr>
            <th className="w-8 py-1 font-medium">
              <span className="sr-only">Rescan</span>
            </th>
            <th className="py-1 pr-3 font-medium">Chain</th>
            <th className="py-1 pr-3 text-right font-medium">Records</th>
            <th className="py-1 pr-3 font-medium">Last scanned</th>
            <th className="py-1 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/60">
          {wallet.chains.map((c) => {
            const key = targetKey(c, wallet.address);
            const s = scans.find((x) => x.chain === c);
            return (
              <tr key={c}>
                <td className="py-1">
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    disabled={disabled}
                    onChange={() => onToggle(key)}
                    aria-label={`Rescan ${CHAIN_LABELS[c] ?? c}`}
                  />
                </td>
                <td className="py-1 pr-3 text-gray-300">{CHAIN_LABELS[c] ?? c}</td>
                <td className="py-1 pr-3 text-right tabular-nums text-gray-400">
                  {s ? s.transfers.toLocaleString() : '—'}
                </td>
                <td className="py-1 pr-3 text-gray-400">
                  {s?.scannedAt ? relativeTime(s.scannedAt) : 'not yet'}
                </td>
                <td className="py-1">
                  {!s ? (
                    <span className="text-gray-500">waiting to scan</span>
                  ) : s.error ? (
                    <span className="text-red-400" title={s.error}>
                      failed: {s.error.slice(0, 60)}
                    </span>
                  ) : s.disabled ? (
                    <span className="text-yellow-500">network not enabled on the Alchemy app</span>
                  ) : s.truncated ? (
                    <span className="text-yellow-500">limit reached — oldest not scanned</span>
                  ) : (
                    <span className="text-gray-500">ok</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
