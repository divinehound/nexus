import { CHAIN_META } from '@nexus/types';
import { defineChain } from 'viem';

/** Robinhood Chain mainnet (Arbitrum Orbit). viem doesn't ship it yet. */
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

/** Alchemy network subdomain for a chain (eth-mainnet when the chain has none). */
export function alchemyNetwork(chain: string): string {
  return CHAIN_META[chain as keyof typeof CHAIN_META]?.alchemySubdomain ?? 'eth-mainnet';
}
