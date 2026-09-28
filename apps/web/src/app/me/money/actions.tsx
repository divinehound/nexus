'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { toast } from 'sonner';
import type { CashflowResponse } from '@nexus/types';

type Run = (
  label: string,
  fn: (token: string, wallet: string | null) => Promise<CashflowResponse>,
) => Promise<boolean>;

const ActionsContext = createContext<{ run: Run; busy: boolean } | null>(null);

/**
 * Link/unlink/tag calls return the rebuilt report; this swaps it in so the
 * whole page updates at once, and reports failures as toasts.
 */
export function CashflowActionsProvider({
  token,
  wallet,
  onResponse,
  children,
}: {
  token: string | null;
  /** Wallet filter in effect, so the rebuilt report comes back filtered the same way. */
  wallet: string | null;
  onResponse: (r: CashflowResponse) => void;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const run = useCallback<Run>(
    async (label, fn) => {
      if (!token) return false;
      setBusy(true);
      try {
        onResponse(await fn(token, wallet));
        toast.success(label);
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Something went wrong');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [token, wallet, onResponse],
  );
  return <ActionsContext.Provider value={{ run, busy }}>{children}</ActionsContext.Provider>;
}

export function useCashflowActions() {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error('useCashflowActions must be used inside CashflowActionsProvider');
  return ctx;
}
