import { useState } from 'react';
import { toast } from 'sonner';
import { holderAnalysis, type ImportResult, sortOldAppRows } from '@/lib/holder-analysis';

// The API takes JSON bodies up to 100 KB: send well under that.
const MAX_BYTES = 60_000;
const batches = (rows: Record<string, unknown>[]) => {
  const out: Record<string, unknown>[][] = [];
  let cur: Record<string, unknown>[] = [];
  let size = 0;
  for (const r of rows) {
    const n = JSON.stringify(r).length + 1;
    if (cur.length && (size + n > MAX_BYTES || cur.length >= 1000)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
};
const EXPORT =
  'npx wrangler d1 execute holder-analysis --remote --json --command "select * from project; select * from wallet_note; select * from unlink" > holder-analysis-export.json';

/**
 * Brings the old holder analysis app's collection settings, wallet labels and notes, and
 * "not the same person" marks into this project, from an export of its D1. Safe to run again:
 * what this project already has is kept.
 */
export function ImportOldApp({ projectId, token, onDone }: { projectId: string; token: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[] | null>(null);

  const run = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      const rows = sortOldAppRows(JSON.parse(await file.text()));
      if (!rows.projects.length && !rows.notes.length && !rows.unlinks.length) throw new Error('No projects, notes or unlinks in that file');
      const parts: ImportResult[] = [];
      const requests = [
        ...(rows.projects.length ? [{ projects: rows.projects }] : []),
        ...batches(rows.notes).map((notes) => ({ notes })),
        ...batches(rows.unlinks).map((unlinks) => ({ unlinks })),
      ];
      let failure = '';
      for (const [i, body] of requests.entries()) {
        try {
          parts.push(await holderAnalysis.adminImport(projectId, body, token));
        } catch (err) {
          // What came before is saved; running it again picks up the rest without doubling anything.
          failure = `Stopped at part ${i + 1} of ${requests.length}: ${err instanceof Error ? err.message : 'it did not work'}. Run it again to bring over the rest.`;
          break;
        }
      }
      const sum = (k: 'labels' | 'unlinks', f: 'added' | 'kept' | 'skipped') => parts.reduce((n, p) => n + p[k][f], 0);
      const s = parts.find((p) => p.settings)?.settings;
      const lines = [
        ...(failure ? [failure] : []),
        ...(s
          ? [
              s.from ? `Settings from "${s.from}": ${s.saved.length ? s.saved.join(', ') : 'none saved'}` : "No collection here matches the old app's contracts, so no settings came over",
              ...(s.kept.length ? [`Kept the settings already saved here for ${s.kept.join(', ')}`] : []),
              ...s.failed.map((f) => `Not saved, ${f.collection}: ${f.error}`),
              ...(s.missing.length ? [`Not in this project (add them to bring their settings over): ${s.missing.join(', ')}`] : []),
            ]
          : []),
        `Labels and notes: ${sum('labels', 'added')} added, ${sum('labels', 'kept')} already here, ${sum('labels', 'skipped')} empty or not a wallet`,
        `Not the same person: ${sum('unlinks', 'added')} added, ${sum('unlinks', 'kept')} already here, ${sum('unlinks', 'skipped')} not wallets`,
      ];
      setResult(lines);
      if (failure) toast.error('Only part of it came over: see below');
      else toast.success('Brought over from the old app');
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not bring that over');
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="mt-4 rounded-lg border border-gray-800 p-3 text-sm">
      <summary className="cursor-pointer text-gray-300">Bring over from the old holder analysis app</summary>
      <div className="mt-3 space-y-3 text-gray-400">
        <p>
          Carries over each collection&apos;s settings, wallet labels and notes, and wallets marked as different people. Chain data is read again by Nexus. Labels, marks and collection settings already saved
          here are kept. Export the old app&apos;s data from the spooky-bar repo&apos;s <code>apps/holder-analysis</code> folder:
        </p>
        <pre className="overflow-x-auto rounded bg-gray-900 p-2 text-xs text-gray-300">{EXPORT}</pre>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-700 px-3 py-1.5 text-gray-200 hover:border-gray-500">
          {busy ? 'Bringing it over…' : 'Choose the export file'}
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) run(f);
            }}
          />
        </label>
        {result && (
          <ul className="list-disc space-y-1 pl-5 text-gray-300">
            {result.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
