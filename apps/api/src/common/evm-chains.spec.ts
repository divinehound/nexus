import { CHAIN_META, EVM_CHAINS, isEvmChain } from '@nexus/types';
import { alchemyNetwork, robinhoodChain } from './evm-chains';

describe('Robinhood Chain', () => {
  it('is a supported EVM chain on Alchemy mainnet', () => {
    expect(EVM_CHAINS).toContain('robinhood');
    expect(isEvmChain('robinhood')).toBe(true);
    expect(CHAIN_META.robinhood).toMatchObject({ evmChainId: 4663, currency: 'ETH', alchemySubdomain: 'robinhood-mainnet' });
    expect(alchemyNetwork('robinhood')).toBe('robinhood-mainnet');
    expect(robinhoodChain.id).toBe(CHAIN_META.robinhood.evmChainId);
  });

  it('keeps the eth-mainnet fallback for unknown chains', () => {
    expect(alchemyNetwork('base')).toBe('base-mainnet');
    expect(alchemyNetwork('solana')).toBe('eth-mainnet');
  });
});
