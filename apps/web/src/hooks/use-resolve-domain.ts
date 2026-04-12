'use client';

import { useEffect } from 'react';
import { useEnsName } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

function isEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/i.test(address);
}

function isSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function detectChainType(address: string, chain?: string): 'evm' | 'solana' | null {
  if (chain) {
    if (chain === 'solana') return 'solana';
    return 'evm';
  }
  if (isEvmAddress(address)) return 'evm';
  if (isSolanaAddress(address)) return 'solana';
  return null;
}

/** Batch resolve Solana SNS domains via our backend API. */
async function resolveSolanaDomainsBatch(
  addresses: string[],
): Promise<Record<string, string | null>> {
  try {
    const result = await apiFetch<{ results: Record<string, string | null> }>(
      '/resolve/domains',
      { method: 'POST', body: JSON.stringify({ addresses }) },
    );
    return result.results;
  } catch {
    return {};
  }
}

/**
 * Resolves an ENS or Solana SNS domain name for a wallet address.
 *
 * For EVM: resolves ENS via wagmi (individual, cached by wagmi).
 * For Solana: reads from the React Query cache only — call
 * usePrefetchSolanaDomains() in the parent page to populate it.
 */
export function useResolveDomain(
  address: string | null | undefined,
  chain?: string,
  knownDomain?: string | null,
) {
  const chainType = address ? detectChainType(address, chain) : null;
  const isEvm = chainType === 'evm';
  const isSolana = chainType === 'solana';

  // ENS resolution via wagmi (always called, but disabled when not EVM)
  const ensResult = useEnsName({
    address: isEvm && address ? (address as `0x${string}`) : undefined,
    query: {
      enabled: isEvm && !!address && !knownDomain,
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
    },
  });

  // Solana SNS: read-only from cache (populated by usePrefetchSolanaDomains)
  // enabled: false means this never fires a fetch — it only reads cache data
  const snsResult = useQuery<string | null>({
    queryKey: ['sns-domain', address],
    queryFn: () => null,
    enabled: false,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  if (knownDomain) {
    return { domain: knownDomain, isLoading: false };
  }

  if (isEvm) {
    return { domain: ensResult.data ?? null, isLoading: ensResult.isLoading };
  }

  if (isSolana) {
    return { domain: snsResult.data ?? null, isLoading: false };
  }

  return { domain: null, isLoading: false };
}

/**
 * Prefetch SNS domains for a batch of Solana addresses.
 * Fires a single POST /api/resolve/domains request, then pushes
 * results into the React Query cache so individual useResolveDomain
 * hooks pick them up automatically.
 */
export function usePrefetchSolanaDomains(
  addresses: string[],
  chain?: string,
) {
  const queryClient = useQueryClient();
  const isSolana = chain === 'solana';

  useEffect(() => {
    if (!isSolana || addresses.length === 0) return;

    const uncached = addresses.filter(
      (addr) => queryClient.getQueryData(['sns-domain', addr]) === undefined,
    );
    if (uncached.length === 0) return;

    resolveSolanaDomainsBatch(uncached).then((results) => {
      for (const [addr, domain] of Object.entries(results)) {
        queryClient.setQueryData(['sns-domain', addr], domain);
      }
    });
  }, [isSolana, JSON.stringify(addresses), queryClient]);
}
