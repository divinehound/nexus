import { cookieStorage, createStorage } from 'wagmi';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { mainnet, base, polygon, type AppKitNetwork } from '@reown/appkit/networks';

// The container's WALLETCONNECT_PROJECT_ID at runtime, else the build-time value.
export const projectId =
  window.__NEXUS_CONFIG__?.walletConnectProjectId || import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'placeholder';

if (projectId === 'placeholder') {
  console.warn('WALLETCONNECT_PROJECT_ID is not set - wallet connections will not work');
}

// Define networks
export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [mainnet, base, polygon];

// Create Wagmi adapter
export const wagmiAdapter = new WagmiAdapter({
  // Cookie storage is kept from the Next.js app so existing wallet connections survive the move.
  storage: createStorage({
    storage: cookieStorage,
  }),
  projectId,
  networks,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
