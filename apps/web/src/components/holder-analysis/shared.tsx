import { Link } from 'react-router';
import { createContext, useContext } from 'react';
import { type Overview, STATUS_LABEL, shortAddr, type Who } from '@/lib/holder-analysis';

/** The project a holder analysis page is about, loaded once by the layout. */
export type AnalysisContext = { slug: string; projectId: string; overview: Overview; token: string; reload: () => void };
const Ctx = createContext<AnalysisContext | null>(null);
export const AnalysisProvider = Ctx.Provider;
export function useAnalysis() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAnalysis must be used inside the holder analysis layout');
  return ctx;
}

const BURN = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);

/** A wallet as a link to its page: the viewer's nickname, else ENS, else OpenSea name, else the short address; the project's label as a tag. */
export function WalletCell({ slug, address, who, full = false }: { slug: string; address: string; who?: Partial<Who> | null; full?: boolean }) {
  if (BURN.has(address)) return <span className="text-gray-500">{address.endsWith('dead') ? 'burn' : 'mint / burn'}</span>;
  const name = who?.nickname || who?.ens || (who?.opensea ? `@${who.opensea}` : '');
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2">
      <Link to={`/project/${slug}/holders/wallet/${address}`} title={address} className="truncate text-purple-300 hover:text-purple-200">
        {full ? <span className="font-mono">{address}</span> : name || <span className="font-mono">{shortAddr(address)}</span>}
      </Link>
      {name && !full && <span className="font-mono text-xs text-gray-500">{shortAddr(address)}</span>}
      {who?.label && <span className="rounded bg-purple-900/50 px-1.5 py-0.5 text-xs text-purple-200">{who.label}</span>}
    </span>
  );
}

/** How long since the wallet did anything: text first, the dot only backs it up. */
const DOT: Record<string, string> = {
  active: 'bg-emerald-400',
  quiet: 'bg-emerald-700',
  parked: 'bg-sky-500',
  dormant_1y: 'bg-gray-400',
  dormant_2y: 'bg-gray-500',
  dormant_3y: 'bg-gray-600',
  dormant_4y: 'bg-gray-700',
  unknown: 'bg-gray-800',
};
export function StatusChip({ status }: { status?: string | null }) {
  if (!status) return null;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-gray-300">
      <span className={`h-2 w-2 rounded-full ${DOT[status] ?? 'bg-gray-700'}`} aria-hidden />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function Pager({ page, perPage, total, shown, onPage }: { page: number; perPage: number; total: number; shown: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  return (
    <div className="flex items-center justify-between py-3 text-sm text-gray-400">
      <span>{total ? `${((page - 1) * perPage + 1).toLocaleString()}–${((page - 1) * perPage + shown).toLocaleString()} of ${total.toLocaleString()}` : 'Nothing found'}</span>
      <span className="flex gap-3">
        {page > 1 && (
          <button className="hover:text-white" onClick={() => onPage(page - 1)}>
            ← Previous
          </button>
        )}
        {page < pages && (
          <button className="hover:text-white" onClick={() => onPage(page + 1)}>
            Next →
          </button>
        )}
      </span>
    </div>
  );
}

export function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-800 p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-gray-400">{sub}</div>}
    </div>
  );
}

export const SELECT = 'rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-white outline-none focus:border-purple-500';
export const INPUT = 'rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500';
export const BUTTON = 'rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:border-purple-500 hover:text-white disabled:opacity-50';
