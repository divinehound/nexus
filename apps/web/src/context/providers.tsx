'use client';

import { useMemo, useState, useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { AuthProvider } from '@/context/auth-context';
import { wagmiConfig } from '@/lib/wagmi';
import '@rainbow-me/rainbowkit/styles.css';
import '@solana/wallet-adapter-react-ui/styles.css';

const solanaEndpoint = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  // Render the same tree on both server and first client paint to avoid
  // hydration mismatch (React error #418). Wallet providers that depend on
  // browser globals (indexedDB, window) are mounted only after hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const solanaWallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  if (!mounted) {
    return (
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          <ConnectionProvider endpoint={solanaEndpoint}>
            <SolanaWalletProvider wallets={solanaWallets} autoConnect={false}>
              <AuthProvider>{children}</AuthProvider>
            </SolanaWalletProvider>
          </ConnectionProvider>
        </WagmiProvider>
      </QueryClientProvider>
    );
  }

  // Browser-only requires to prevent SSR evaluation side effects from wallet libs.
  const { RainbowKitProvider, darkTheme } = require('@rainbow-me/rainbowkit');
  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>
        <RainbowKitProvider theme={darkTheme({ accentColor: '#a855f7' })}>
          <ConnectionProvider endpoint={solanaEndpoint}>
            <SolanaWalletProvider wallets={solanaWallets} autoConnect>
              <AuthProvider>{children}</AuthProvider>
            </SolanaWalletProvider>
          </ConnectionProvider>
        </RainbowKitProvider>
      </WagmiProvider>
    </QueryClientProvider>
  );
}
