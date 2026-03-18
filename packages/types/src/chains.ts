import { Chain } from './common';

export interface ChainMeta {
  /** Display name */
  name: string;
  /** Native currency symbol */
  currency: string;
  /** EVM chain ID (undefined for non-EVM chains) */
  evmChainId?: number;
  /** Alchemy network subdomain (undefined if Alchemy doesn't support it) */
  alchemySubdomain?: string;
  /** Whether the chain is EVM-compatible */
  isEvm: boolean;
}

export const CHAIN_META: Record<Chain, ChainMeta> = {
  [Chain.ETHEREUM]: {
    name: 'Ethereum',
    currency: 'ETH',
    evmChainId: 1,
    alchemySubdomain: 'eth-mainnet',
    isEvm: true,
  },
  [Chain.BASE]: {
    name: 'Base',
    currency: 'ETH',
    evmChainId: 8453,
    alchemySubdomain: 'base-mainnet',
    isEvm: true,
  },
  [Chain.ABSTRACT]: {
    name: 'Abstract',
    currency: 'ETH',
    evmChainId: 2741,
    alchemySubdomain: 'abstract-mainnet',
    isEvm: true,
  },
  [Chain.APECHAIN]: {
    name: 'ApeChain',
    currency: 'APE',
    evmChainId: 33139,
    // Alchemy does not natively support ApeChain — use a fallback RPC
    alchemySubdomain: undefined,
    isEvm: true,
  },
  [Chain.POLYGON]: {
    name: 'Polygon',
    currency: 'POL',
    evmChainId: 137,
    alchemySubdomain: 'polygon-mainnet',
    isEvm: true,
  },
  [Chain.SOLANA]: {
    name: 'Solana',
    currency: 'SOL',
    isEvm: false,
  },
};

/** Get the native currency symbol for a chain */
export function chainCurrency(chain: string): string {
  return CHAIN_META[chain as Chain]?.currency ?? 'ETH';
}

/** Get display name for a chain */
export function chainDisplayName(chain: string): string {
  return CHAIN_META[chain as Chain]?.name ?? chain;
}

/** Get the EVM chain ID for a chain, or undefined if not EVM */
export function chainEvmId(chain: string): number | undefined {
  return CHAIN_META[chain as Chain]?.evmChainId;
}
