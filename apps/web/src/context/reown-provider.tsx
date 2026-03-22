'use client';

import { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { createAppKit } from '@reown/appkit/react';
import { SolanaAdapter } from '@reown/appkit-adapter-solana/react';
import { solana, solanaTestnet, solanaDevnet } from '@reown/appkit/networks';
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from '@solana/wallet-adapter-wallets';

import { projectId, wagmiAdapter, wagmiConfig, networks } from '@/lib/reown-config';

// Set up query client
const queryClient = new QueryClient();

// Solana adapter
const solanaWeb3JsAdapter = new SolanaAdapter({
  wallets: [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
});

// Create the modal
const modal = createAppKit({
  adapters: [wagmiAdapter, solanaWeb3JsAdapter],
  projectId,
  networks: [...networks, solana, solanaTestnet, solanaDevnet],
  defaultNetwork: networks[0],
  metadata: {
    name: 'NEXUS',
    description: 'NFT ecosystem indexing and discovery platform',
    url: typeof window !== 'undefined' ? window.location.origin : 'https://nexus.dev.intentionworks.xyz',
    icons: [typeof window !== 'undefined' ? `${window.location.origin}/icon.svg` : 'https://nexus.dev.intentionworks.xyz/icon.svg']
  },
  features: {
    analytics: true,
    email: false,
    socials: false,
  },
  featuredWalletIds: [
    'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96', // MetaMask
    'a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393', // Phantom
    'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa', // Coinbase Wallet
  ],
  themeMode: 'dark',
  themeVariables: {
    '--w3m-accent': '#a855f7',
  },
});

export function ReownProvider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
