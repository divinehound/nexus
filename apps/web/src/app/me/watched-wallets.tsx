'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  addWatchedWallet,
  getWatchedWallets,
  removeWatchedWallet,
  type WatchedWallet,
} from '@/lib/api';
import { truncateAddress } from '@/lib/utils';

/**
 * Wallets added by address, without signing — old burners, or a wallet that
 * can't connect here. They count on the Money dashboard but never sign in.
 */
export function WatchedWalletsSection({ accessToken }: { accessToken: string }) {
  const [rows, setRows] = useState<WatchedWallet[]>([]);
  const [family, setFamily] = useState<'evm' | 'solana'>('evm');
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await getWatchedWallets(accessToken));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load watch-only wallets');
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addWatchedWallet(accessToken, {
        family,
        address: address.trim(),
        label: label.trim() || undefined,
      });
      setAddress('');
      setLabel('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add wallet');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await removeWatchedWallet(accessToken, id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove wallet');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-gray-800 p-6">
      <h2 className="text-xl font-semibold">Watch-only Wallets</h2>
      <p className="mt-1 text-sm text-gray-400">
        Add a wallet by address without connecting it — old burners, or a wallet that won&apos;t
        connect here. They&apos;re counted as yours on the{' '}
        <Link href="/me/money" className="text-purple-300 hover:text-purple-200">
          Money
        </Link>{' '}
        dashboard (so moves between them aren&apos;t spending), but they can&apos;t be used to sign
        in. If someone verifies one of these by signing with it, it moves to their account.
      </p>

      <div className="mt-4 space-y-2">
        {rows.length === 0 ? (
          <p className="text-sm text-gray-500">No watch-only wallets.</p>
        ) : (
          rows.map((w) => (
            <div
              key={w.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-800 p-3"
            >
              <div>
                <p className="text-sm font-medium text-white">
                  {w.family === 'evm' ? 'EVM' : 'SOLANA'} {w.label || truncateAddress(w.address)}
                  <span className="ml-2 text-xs text-yellow-400/80">WATCH-ONLY</span>
                </p>
                <p className="text-xs text-gray-500">{w.address}</p>
              </div>
              <button
                onClick={() => void onRemove(w.id)}
                disabled={busy}
                className="rounded-md border border-red-800 px-3 py-1.5 text-xs text-red-300 hover:border-red-600 disabled:opacity-60"
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      <form onSubmit={onAdd} className="mt-4 flex flex-wrap items-center gap-2">
        <select
          value={family}
          onChange={(e) => setFamily(e.target.value as 'evm' | 'solana')}
          aria-label="Wallet type"
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200"
        >
          <option value="evm">EVM (all EVM chains)</option>
          <option value="solana">Solana</option>
        </select>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={family === 'evm' ? '0x…' : 'Solana address'}
          required
          className="min-w-72 flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 font-mono text-sm text-gray-200"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          maxLength={100}
          className="w-44 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200"
        />
        <button
          type="submit"
          disabled={busy || !address.trim()}
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50"
        >
          Add wallet
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}
