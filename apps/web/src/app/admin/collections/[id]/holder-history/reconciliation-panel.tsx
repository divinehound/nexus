'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  adminGetSolanaReconciliation,
  adminGetSolanaSignatureRawData,
  adminMarkSolanaSignaturesForReview,
} from '@/lib/api';

type Props = {
  collectionId: string;
  accessToken: string | null;
  onRefreshNeeded?: () => void;
};

type Mismatch = {
  mintAddress: string;
  dasOwner: string | null;
  computedOwner: string | null;
  reconciliationNote: string | null;
  signatureCount: number;
  signatures: Array<{
    signature: string;
    blockTime: string | null;
    slot: number | null;
    parseStatus: string;
    transfersFound: number;
    errorMessage: string | null;
  }>;
  transferCount: number;
  transfers: Array<{
    signature: string;
    mintAddress: string;
    fromWallet: string | null;
    toWallet: string | null;
    blockTime: string;
    slot: number;
    parserName: string;
    programId: string | null;
  }>;
};

export default function ReconciliationPanel({ collectionId, accessToken }: Props) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<{
    summary: { ok: number; mismatch: number; pending: number; total: number };
    mismatches: Mismatch[];
  } | null>(null);
  const [inspectMint, setInspectMint] = useState<Mismatch | null>(null);

  const load = async () => {
    if (!accessToken || !collectionId) return;
    setLoading(true);
    try {
      const result = await adminGetSolanaReconciliation(collectionId, accessToken, 200);
      setData({ summary: result.summary, mismatches: result.mismatches });
    } catch (err: any) {
      toast.error(err?.message || 'Failed to load reconciliation');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [accessToken, collectionId]);

  const markForReview = async (mint: Mismatch) => {
    if (!accessToken) return;
    const signatures = mint.signatures.map((s) => s.signature);
    if (signatures.length === 0) {
      toast.error('No signatures to mark');
      return;
    }
    try {
      await adminMarkSolanaSignaturesForReview(collectionId, signatures, accessToken);
      toast.success(`Marked ${signatures.length} signatures for re-parsing`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to mark for review');
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-5 text-sm text-gray-400">
        Loading reconciliation...
      </div>
    );
  }

  if (!data) return null;

  const { summary, mismatches } = data;

  return (
    <>
      <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Reconciliation</h2>
            <p className="mt-1 text-sm text-gray-400">
              Computed ownership vs DAS current ownership. Mismatches are assets where our parsed transfer history
              doesn&apos;t end at the wallet DAS reports as the current owner.
            </p>
          </div>
          <button
            onClick={load}
            className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:text-white"
          >
            Refresh
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-3">
            <div className="text-xs uppercase tracking-wide text-gray-500">Total</div>
            <div className="mt-1 text-xl font-semibold text-white">{summary.total}</div>
          </div>
          <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/30 p-3">
            <div className="text-xs uppercase tracking-wide text-emerald-400">Reconciled</div>
            <div className="mt-1 text-xl font-semibold text-emerald-300">{summary.ok}</div>
          </div>
          <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 p-3">
            <div className="text-xs uppercase tracking-wide text-rose-400">Mismatched</div>
            <div className="mt-1 text-xl font-semibold text-rose-300">{summary.mismatch}</div>
          </div>
          <div className="rounded-lg border border-yellow-900/50 bg-yellow-950/30 p-3">
            <div className="text-xs uppercase tracking-wide text-yellow-400">Pending</div>
            <div className="mt-1 text-xl font-semibold text-yellow-300">{summary.pending}</div>
          </div>
        </div>

        {mismatches.length > 0 && (
          <div className="mt-5">
            <div className="text-sm font-medium text-white">
              Mismatched mints ({mismatches.length}
              {summary.mismatch > mismatches.length ? ` of ${summary.mismatch}` : ''})
            </div>
            <div className="mt-2 max-h-[400px] overflow-y-auto rounded border border-gray-800">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-gray-900">
                  <tr className="text-left uppercase tracking-wide text-gray-500">
                    <th className="px-3 py-2">Mint</th>
                    <th className="px-3 py-2">DAS Owner</th>
                    <th className="px-3 py-2">Computed Owner</th>
                    <th className="px-3 py-2">Sigs / Transfers</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {mismatches.map((m) => (
                    <tr key={m.mintAddress} className="border-t border-gray-800 hover:bg-gray-900/40" title={m.reconciliationNote || ''}>
                      <td className="px-3 py-2">
                        <a
                          href={`https://solscan.io/token/${m.mintAddress}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-purple-300 hover:text-purple-200"
                          title={m.mintAddress}
                        >
                          {truncate(m.mintAddress)} ↗
                        </a>
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-300" title={m.dasOwner || ''}>
                        {m.dasOwner ? truncate(m.dasOwner) : '—'}
                      </td>
                      <td className="px-3 py-2 font-mono" title={m.computedOwner || ''}>
                        {m.computedOwner ? (
                          <span
                            className={
                              m.dasOwner && m.computedOwner === m.dasOwner
                                ? 'text-yellow-300'
                                : 'text-gray-300'
                            }
                          >
                            {m.dasOwner && m.computedOwner === m.dasOwner ? '⚠ ' : ''}
                            {truncate(m.computedOwner)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-400">
                        {m.signatureCount} / {m.transferCount}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-2">
                          <button
                            onClick={() => setInspectMint(m)}
                            className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-white"
                          >
                            Inspect
                          </button>
                          <button
                            onClick={() => markForReview(m)}
                            className="rounded border border-purple-700 px-2 py-1 text-xs text-purple-300 hover:text-purple-200"
                            title="Mark all signatures for re-parsing on next scan"
                          >
                            Re-parse
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {mismatches.length === 0 && summary.total > 0 && (
          <div className="mt-4 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-3 text-sm text-emerald-300">
            ✓ All {summary.total} mints reconciled successfully
          </div>
        )}
      </div>

      {inspectMint && (
        <InspectModal
          mint={inspectMint}
          accessToken={accessToken}
          onClose={() => setInspectMint(null)}
        />
      )}
    </>
  );
}

function InspectModal({
  mint,
  accessToken,
  onClose,
}: {
  mint: Mismatch;
  accessToken: string | null;
  onClose: () => void;
}) {
  const [expandedSig, setExpandedSig] = useState<string | null>(null);
  const [rawDataCache, setRawDataCache] = useState<Record<string, any>>({});
  const [loadingSig, setLoadingSig] = useState<string | null>(null);

  const toggleSig = async (signature: string) => {
    if (expandedSig === signature) {
      setExpandedSig(null);
      return;
    }
    setExpandedSig(signature);
    if (!rawDataCache[signature] && accessToken) {
      setLoadingSig(signature);
      try {
        const data = await adminGetSolanaSignatureRawData(signature, accessToken);
        setRawDataCache((prev) => ({ ...prev, [signature]: data }));
      } catch (err: any) {
        toast.error(`Failed to fetch raw data: ${err?.message || err}`);
      } finally {
        setLoadingSig(null);
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-xl border border-gray-800 bg-gray-950 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">Inspect Mint</h3>
            <div className="mt-1 flex items-center gap-2 font-mono text-xs text-gray-300">
              <a
                href={`https://solscan.io/token/${mint.mintAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-300 hover:text-purple-200"
              >
                {mint.mintAddress} ↗
              </a>
            </div>
            <div className="mt-2 text-sm text-gray-400">
              <div>
                <span className="text-rose-300">DAS says:</span>{' '}
                <span className="font-mono">{mint.dasOwner || '—'}</span>
                {mint.dasOwner && <span className="ml-2 text-gray-600">(len {mint.dasOwner.length})</span>}
              </div>
              <div className="mt-1">
                <span className="text-yellow-300">We computed:</span>{' '}
                <span className="font-mono">{mint.computedOwner || '—'}</span>
                {mint.computedOwner && (
                  <span className="ml-2 text-gray-600">(len {mint.computedOwner.length})</span>
                )}
              </div>
              {mint.dasOwner && mint.computedOwner && mint.dasOwner === mint.computedOwner && (
                <div className="mt-1 text-emerald-300">
                  ✓ Strings match byte-for-byte — mismatch is likely stale, re-run scan
                </div>
              )}
            </div>
            {mint.reconciliationNote && (
              <div className="mt-1 text-xs text-gray-500">{mint.reconciliationNote}</div>
            )}
          </div>
          <button onClick={onClose} className="text-2xl text-gray-500 hover:text-white">
            ×
          </button>
        </div>

        <div className="mt-5">
          <div className="text-sm font-medium text-white">
            Signatures ({mint.signatureCount}) · Extracted transfers ({mint.transferCount})
          </div>
          <div className="mt-2 space-y-2">
            {mint.signatures.map((sig) => {
              const extractedForThisSig = mint.transfers.filter((t) => t.signature === sig.signature);
              const isExpanded = expandedSig === sig.signature;
              const rawData = rawDataCache[sig.signature];
              return (
                <div key={sig.signature} className="rounded border border-gray-800 bg-gray-900/40">
                  <div className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="flex items-center gap-2 overflow-hidden">
                      <button
                        onClick={() => toggleSig(sig.signature)}
                        className="text-gray-500 hover:text-white"
                      >
                        {isExpanded ? '▼' : '▶'}
                      </button>
                      <a
                        href={`https://solscan.io/tx/${sig.signature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate font-mono text-xs text-purple-300 hover:text-purple-200"
                      >
                        {sig.signature.substring(0, 40)}... ↗
                      </a>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span
                        className={
                          sig.parseStatus === 'success'
                            ? 'rounded bg-emerald-900/40 px-2 py-0.5 text-emerald-300'
                            : sig.parseStatus === 'failed'
                              ? 'rounded bg-rose-900/40 px-2 py-0.5 text-rose-300'
                              : 'rounded bg-yellow-900/40 px-2 py-0.5 text-yellow-300'
                        }
                      >
                        {sig.parseStatus}
                      </span>
                      <span className="text-gray-500">
                        {sig.transfersFound} transfer{sig.transfersFound === 1 ? '' : 's'}
                      </span>
                      {sig.blockTime && (
                        <span className="text-gray-500">
                          {new Date(sig.blockTime).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-gray-800 p-3 text-xs">
                      {sig.errorMessage && (
                        <div className="mb-2 rounded bg-rose-950/40 p-2 text-rose-300">
                          Error: {sig.errorMessage}
                        </div>
                      )}

                      {extractedForThisSig.length > 0 && (
                        <div className="mb-3">
                          <div className="mb-1 font-medium text-gray-300">Extracted transfers:</div>
                          <div className="space-y-1">
                            {extractedForThisSig.map((t, i) => (
                              <div key={i} className="rounded bg-gray-900 p-2">
                                <div className="flex items-center gap-2 text-gray-400">
                                  <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-purple-300">
                                    {t.parserName}
                                  </span>
                                  <span className="font-mono">{truncate(t.fromWallet || '(mint)')}</span>
                                  <span>→</span>
                                  <span className="font-mono">{truncate(t.toWallet || '(burn)')}</span>
                                </div>
                                {t.programId && (
                                  <div className="mt-1 font-mono text-[10px] text-gray-600">
                                    program: {t.programId}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {loadingSig === sig.signature && <div className="text-gray-500">Loading raw data...</div>}

                      {rawData && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-gray-400 hover:text-white">
                            Raw Helius response
                          </summary>
                          <pre className="mt-2 max-h-96 overflow-auto rounded bg-black/40 p-2 font-mono text-[10px] text-gray-300">
                            {JSON.stringify(rawData.rawData, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function truncate(s: string) {
  if (!s) return s;
  if (s.length <= 14) return s;
  return `${s.substring(0, 6)}...${s.substring(s.length - 6)}`;
}
