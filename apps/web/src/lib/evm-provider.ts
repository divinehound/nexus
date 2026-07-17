/**
 * Minimal EIP-1193-style provider surface used for wallet message signing.
 * @reown/appkit-adapter-wagmi stopped exporting a Provider type, so we type
 * only what we actually call on the provider returned by useAppKitProvider.
 */
export interface EvmProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}
