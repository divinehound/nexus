import { cookieStorage, createStorage } from 'wagmi';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { mainnet, base, polygon } from '@reown/appkit/networks';

// Get projectId from env
export const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID!;

if (!projectId) {
  throw new Error('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set');
}

// Define networks
export const networks = [mainnet, base, polygon];

// Create Wagmi adapter
export const wagmiAdapter = new WagmiAdapter({
  storage: createStorage({
    storage: cookieStorage,
  }),
  ssr: true,
  projectId,
  networks,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
