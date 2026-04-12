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

/** Resolve a single Solana SNS domain via our backend API. */
async function resolveSolanaDomain(address: string): Promise<string | null> {
  try {
    const result = await apiFetch<{ domain: string | null }>(
      `/resolve/domain?address=${encodeURIComponent(address)}`,
    );
    return result.domain;
  } catch {
    return null;
  }
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
 * Returns the domain name if found, null otherwise.
 * Auto-detects chain from address format if not provided.
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

  // Solana SNS resolution via backend API (always called, but disabled when not Solana)
  const snsResult = useQuery({
    queryKey: ['sns-domain', address],
    queryFn: () => resolveSolanaDomain(address!),
    enabled: isSolana && !!address && !knownDomain,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });

  // If known domain is provided, use it directly
  if (knownDomain) {
    return { domain: knownDomain, isLoading: false };
  }

  if (isEvm) {
    return { domain: ensResult.data ?? null, isLoading: ensResult.isLoading };
  }

  if (isSolana) {
    return { domain: snsResult.data ?? null, isLoading: snsResult.isLoading };
  }

  return { domain: null, isLoading: false };
}

/**
 * Prefetch SNS domains for a batch of Solana addresses.
 * Call this once with all visible addresses; results are
 * pushed into the React Query cache so individual
 * useResolveDomain hooks resolve instantly.
 */
export function usePrefetchSolanaDomains(
  addresses: string[],
  chain?: string,
) {
  const queryClient = useQueryClient();
  const isSolana = chain === 'solana';

  useEffect(() => {
    if (!isSolana || addresses.length === 0) return;

    // Only fetch addresses not already cached
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
