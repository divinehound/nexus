'use client';

import { useEnsName } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { Connection, PublicKey } from '@solana/web3.js';
import { getFavoriteDomain } from '@bonfida/spl-name-service';

const SOLANA_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

let _solanaCon: Connection | null = null;
function getSolanaConnection(): Connection {
  if (!_solanaCon) _solanaCon = new Connection(SOLANA_RPC);
  return _solanaCon;
}

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

async function resolveSolanaDomain(address: string): Promise<string | null> {
  try {
    const connection = getSolanaConnection();
    const owner = new PublicKey(address);
    const { reverse } = await getFavoriteDomain(connection, owner);
    return reverse ? `${reverse}.sol` : null;
  } catch {
    return null;
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

  // Solana SNS resolution via bonfida (always called, but disabled when not Solana)
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
