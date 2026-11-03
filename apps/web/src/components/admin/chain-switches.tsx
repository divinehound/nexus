import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/ui/dialogs';
import { type AdminChain, getAdminChains, setAdminChainEnabled } from '@/lib/api';

/**
 * Turns a chain's background work on or off: scheduled holder refreshes, the holder backlog,
 * discovery and holder analysis. Data already read stays, and admins can still index one
 * collection by hand.
 */
export function ChainSwitches({ token }: { token: string }) {
  const [chains, setChains] = useState<AdminChain[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stale = false;
    getAdminChains(token)
      .then((c) => !stale && setChains(c))
      .catch((err) => !stale && setError(err instanceof Error ? err.message : 'Could not load the chains'));
    return () => {
      stale = true;
    };
  }, [token]);

  const toggle = async (c: AdminChain) => {
    if (c.enabled) {
      const ok = await confirmDialog({
        title: `Switch off ${c.chain}?`,
        message: `Its ${c.collections.toLocaleString()} collections stop getting scheduled refreshes, backlog and discovery indexing, and holder analysis. What's already read stays.`,
        confirmText: 'Switch off',
      });
      if (!ok) return;
    }
    setBusy(c.chain);
    try {
      setChains(await setAdminChainEnabled(c.chain, !c.enabled, token));
      toast.success(`${c.chain} switched ${c.enabled ? 'off' : 'on'}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change the chain');
    } finally {
      setBusy(null);
    }
  };

  if (error) return <p className="mb-6 text-sm text-red-400">Chains: {error}</p>;
  if (!chains) return null;
  return (
    <section className="mb-6 rounded border border-gray-800 p-4">
      <h3 className="text-sm font-medium text-white">Chains</h3>
      <p className="mt-1 text-xs text-gray-500">
        A chain that's off gets no scheduled refreshes, backlog or discovery indexing, or holder analysis. Indexing one collection by hand still works.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {chains.map((c) => (
          <div key={c.chain} className="flex items-center justify-between gap-3 rounded border border-gray-800 px-3 py-2">
            <div>
              <div className={`text-sm ${c.enabled ? 'text-white' : 'text-gray-500'}`}>{c.chain}</div>
              <div className="text-xs text-gray-500">
                {c.collections.toLocaleString()} collections · {c.scheduled.toLocaleString()} on a schedule
              </div>
            </div>
            <button
              onClick={() => toggle(c)}
              // One switch at a time, so an older reply can't flip another back on screen.
              disabled={busy !== null}
              className={`rounded border px-3 py-1 text-xs ${c.enabled ? 'border-emerald-800 text-emerald-400' : 'border-gray-700 text-gray-400'}`}
              aria-pressed={c.enabled}
            >
              {c.enabled ? 'On' : 'Off'}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
