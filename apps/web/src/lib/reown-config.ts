import { cookieStorage, createStorage } from 'wagmi';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { mainnet, base, polygon, type AppKitNetwork } from '@reown/appkit/networks';

// Get projectId from env (fallback to placeholder for build)
export const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'placeholder';

if (projectId === 'placeholder' && typeof window !== 'undefined') {
  console.warn('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set - wallet connections will not work');
}

// Define networks
export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [mainnet, base, polygon];

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
