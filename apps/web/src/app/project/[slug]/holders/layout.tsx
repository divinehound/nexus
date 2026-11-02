'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { AuthGate } from '@/components/wallet/auth-gate';
import { AnalysisProvider, BUTTON } from '@/components/holder-analysis/shared';
import { useAuth } from '@/context/auth-context';
import { apiFetch, ApiError } from '@/lib/api';
import { day, holderAnalysis, type Overview } from '@/lib/holder-analysis';

/** The holder analysis pages of one project: for its owners and editors, and Nexus admins. */
export default function HoldersLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  return (
    <AuthGate>
      <Loaded params={params}>{children}</Loaded>
    </AuthGate>
  );
}

function Loaded({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { accessToken } = useAuth();
  const pathname = usePathname();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analysing, setAnalysing] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const id = projectId ?? (await apiFetch<{ id: string }>(`/projects/${slug}`)).id;
      setProjectId(id);
      setOverview(await holderAnalysis.overview(id, accessToken));
      setError(null);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(
        status === 403
          ? "The holder analysis is only for this project's owners and editors."
          : status === 404
            ? 'Holder analysis is off for this project. A Nexus admin can turn it on from the project in the admin panel.'
            : err instanceof Error
              ? err.message
              : 'Could not load the holder analysis',
      );
    }
  }, [accessToken, slug, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error)
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <Link href={`/project/${slug}`} className="text-sm text-gray-500 hover:text-white">
          ← Back to the project
        </Link>
        <p className="mt-6 text-gray-300">{error}</p>
      </main>
    );
  if (!overview || !projectId || !accessToken)
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
      </div>
    );

  const root = `/project/${slug}/holders`;
  const tabs = [
    { href: root, label: 'Holders' },
    { href: `${root}/groups`, label: 'Related wallets' },
    { href: `${root}/activity`, label: 'Activity' },
  ];
  const report = overview.report;
  const analyse = async () => {
    setAnalysing(true);
    try {
      const r = await holderAnalysis.analyse(projectId, accessToken);
      toast.success(r.queued ? 'Analysis queued: it usually takes under a minute' : 'An analysis is already queued');
      setTimeout(load, 15_000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the analysis');
    } finally {
      setAnalysing(false);
    }
  };

  return (
    <AnalysisProvider value={{ slug, projectId, overview, token: accessToken, reload: load }}>
      <main className="mx-auto max-w-7xl px-4 py-8">
        <Link href={`/project/${slug}`} className="text-sm text-gray-500 hover:text-white">
          ← {overview.name}
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Holder analysis</h1>
            <p className="mt-1 text-sm text-gray-400">
              {report
                ? `As of ${report.summary.as_of} · analysed ${day(report.analysedAt)} · ${overview.collections.map((c) => c.name).join(', ')}`
                : overview.waiting.length
                  ? `Reading the chain for ${overview.waiting.length} of ${overview.collections.length} collections. The first report comes once they've all caught up.`
                  : 'No report yet.'}
            </p>
          </div>
          <button className={BUTTON} onClick={analyse} disabled={analysing || overview.waiting.length > 0} title="It also runs daily and within half an hour of new transfers">
            {analysing ? 'Queuing…' : 'Re-analyse now'}
          </button>
        </div>
        <nav className="mt-6 flex gap-1 border-b border-gray-800">
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className={`border-b-2 px-4 py-2 text-sm transition-colors ${
                pathname === t.href ? 'border-purple-500 text-white' : 'border-transparent text-gray-400 hover:text-white'
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="mt-6">{children}</div>
      </main>
    </AnalysisProvider>
  );
}
