'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { toast } from 'sonner';
import type { CashflowResponse } from '@nexus/types';
import type { CashflowView } from '@/lib/api';

type Run = (
  label: string,
  fn: (token: string, view: CashflowView) => Promise<CashflowResponse>,
  /** A problem to show instead of the success message (the change was still saved). */
  warn?: (response: CashflowResponse) => string | null,
) => Promise<boolean>;

const ActionsContext = createContext<{ run: Run; busy: boolean } | null>(null);

/**
 * Link/unlink/tag/flag/scan calls return the rebuilt report (or scan progress); this swaps it in so the
 * whole page updates at once, and reports failures as toasts.
 */
export function CashflowActionsProvider({
  token,
  view,
  onResponse,
  children,
}: {
  token: string | null;
  /** Wallet/chain filter in effect, so the rebuilt report comes back filtered the same way. */
  view: CashflowView;
  onResponse: (r: CashflowResponse) => void;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const run = useCallback<Run>(
    async (label, fn, warn) => {
      if (!token) return false;
      setBusy(true);
      try {
        const response = await fn(token, view);
        onResponse(response);
        const problem = warn?.(response);
        if (problem) toast.warning(problem, { duration: 12_000 });
        else toast.success(label);
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Something went wrong');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [token, view, onResponse],
  );
  return <ActionsContext.Provider value={{ run, busy }}>{children}</ActionsContext.Provider>;
}

export function useCashflowActions() {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error('useCashflowActions must be used inside CashflowActionsProvider');
  return ctx;
}
