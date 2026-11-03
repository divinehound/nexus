import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/ui/dialogs';
import { type AdminServiceLevels, getAdminServiceLevels, runAdminServiceLevelCheck, SERVICE_LEVELS } from '@/lib/api';

/** How many collections sit at each service level, the last weekly check, and a way to run it now. */
export function ServiceLevels({ token }: { token: string }) {
  const [data, setData] = useState<AdminServiceLevels | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    getAdminServiceLevels(token)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the service levels'));
  }, [token]);
  useEffect(load, [load]);

  const run = async () => {
    const ok = await confirmDialog({
      title: 'Check service levels now?',
      message: 'Counts recent transfers for every collection that is not pinned (one Alchemy call each), then sets its level. It also runs every Sunday; other days only new collections are checked.',
      confirmText: 'Check now',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await runAdminServiceLevelCheck(token);
      toast.success(r.queued ? 'Check started' : 'A check is already running');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the check');
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <p className="mb-6 text-sm text-red-400">Service levels: {error}</p> : null;
  const { check } = data;
  return (
    <section className="mb-6 rounded border border-gray-800 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-white">Service levels</h3>
          <p className="mt-1 text-xs text-gray-500">
            {check.running
              ? 'A check is running now.'
              : check.finishedAt
                ? `Last full check ${new Date(check.finishedAt).toLocaleString()}${
                    check.error
                      ? ` failed: ${check.error}`
                      : check.result
                        ? `: ${check.result.checked.toLocaleString()} checked, ${check.result.failed} failed${check.result.skipped ? `, ${check.result.skipped} skipped (no Alchemy key or network)` : ''}`
                        : ''
                  }. Runs every Sunday; new collections daily.`
                : 'No full check yet. Runs every Sunday; new collections daily.'}
            {error && <span className="block text-red-400">Could not refresh: {error}</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="rounded border border-gray-700 px-3 py-1 text-xs text-gray-300">
            Refresh
          </button>
          <button onClick={run} disabled={busy || check.running} className="rounded border border-purple-700 px-3 py-1 text-xs text-purple-200 disabled:opacity-50">
            Check now
          </button>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {SERVICE_LEVELS.map((l) => {
          const row = data.levels.find((r) => r.level === l.value);
          return (
            <div key={l.value} className="rounded border border-gray-800 px-3 py-2">
              <div className="text-lg text-white">{(row?.total ?? 0).toLocaleString()}</div>
              <div className="text-xs text-gray-400">
                {l.label} · {l.refresh}
              </div>
              {row?.pinned ? <div className="text-xs text-gray-500">{row.pinned.toLocaleString()} pinned</div> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
