'use client';

import { useResolveDomain } from '@/hooks/use-resolve-domain';
import { truncateAddress } from '@/lib/utils';

interface AddressDisplayProps {
  address: string;
  /** Chain hint — auto-detected from address format if omitted */
  chain?: string;
  /** Pre-resolved domain name from DB (skips on-the-fly resolution) */
  knownDomain?: string | null;
  /** Number of leading/trailing chars for truncation (default 4) */
  chars?: number;
  className?: string;
}

/**
 * Displays an ENS/SNS domain name for a wallet address when available,
 * falling back to a truncated address. The full address is always shown
 * in the title attribute on hover.
 *
 * Does NOT handle copy-to-clipboard — parent components should handle
 * copying the raw address directly.
 */
export function AddressDisplay({
  address,
  chain,
  knownDomain,
  chars = 4,
  className,
}: AddressDisplayProps) {
  const { domain, isLoading } = useResolveDomain(address, chain, knownDomain);

  const displayText = domain || truncateAddress(address, chars);

  return (
    <span className={className} title={address}>
      {displayText}
    </span>
  );
}
