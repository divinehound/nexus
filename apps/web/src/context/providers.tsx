'use client';

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/auth-context';
import { wagmiConfig } from '@/lib/wagmi';
import '@rainbow-me/rainbowkit/styles.css';
import '@solana/wallet-adapter-react-ui/styles.css';

const solanaEndpoint = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  // During SSR/prerender avoid wallet providers that touch browser globals,
  // but always provide react-query context so hooks never throw.
  if (typeof window === 'undefined') {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  }

  // Browser-only requires to prevent SSR evaluation side effects from wallet libs.
  const { WagmiProvider } = require('wagmi');
  const { RainbowKitProvider, darkTheme } = require('@rainbow-me/rainbowkit');
  const {
    ConnectionProvider,
    WalletProvider: SolanaWalletProvider,
  } = require('@solana/wallet-adapter-react');
  const {
    PhantomWalletAdapter,
    SolflareWalletAdapter,
  } = require('@solana/wallet-adapter-wallets');
  const { AbstractWalletProvider } = require('@abstract-foundation/agw-react');

  const solanaWallets = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>
        <RainbowKitProvider theme={darkTheme({ accentColor: '#a855f7' })}>
          <AbstractWalletProvider chain={'abstract' as any}>
            <ConnectionProvider endpoint={solanaEndpoint}>
              <SolanaWalletProvider wallets={solanaWallets} autoConnect>
                <AuthProvider>{children}</AuthProvider>
              </SolanaWalletProvider>
            </ConnectionProvider>
          </AbstractWalletProvider>
        </RainbowKitProvider>
      </WagmiProvider>
    </QueryClientProvider>
  );
}
