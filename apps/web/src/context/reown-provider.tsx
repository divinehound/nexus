'use client';

import { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createAppKit } from '@reown/appkit/react';
import { SolanaAdapter } from '@reown/appkit-adapter-solana/react';
import { solana, solanaTestnet, solanaDevnet } from '@reown/appkit/networks';
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from '@solana/wallet-adapter-wallets';

import { projectId, wagmiAdapter, networks } from '@/lib/reown-config';

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
  themeMode: 'dark',
  themeVariables: {
    '--w3m-accent': '#a855f7',
  },
});

export function ReownProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
