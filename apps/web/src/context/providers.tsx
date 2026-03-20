'use client';

import { useState, useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/auth-context';
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

  // Keep Solana wallet context mounted even before full hydration so hooks
  // like useWallet on /me never throw "without providing WalletProvider".
  const {
    ConnectionProvider,
    WalletProvider: SolanaWalletProvider,
  } = require('@solana/wallet-adapter-react');

  if (!mounted) {
    return (
      <QueryClientProvider client={queryClient}>
        <ConnectionProvider endpoint={solanaEndpoint}>
          <SolanaWalletProvider wallets={[]} autoConnect={false}>
            <AuthProvider>{children}</AuthProvider>
          </SolanaWalletProvider>
        </ConnectionProvider>
      </QueryClientProvider>
    );
  }

  // Browser-only requires to prevent SSR evaluation side effects from wallet libs.
  const { wagmiConfig } = require('@/lib/wagmi');
  const { WagmiProvider } = require('wagmi');
  const { RainbowKitProvider, darkTheme } = require('@rainbow-me/rainbowkit');
  const {
    PhantomWalletAdapter,
    SolflareWalletAdapter,
  } = require('@solana/wallet-adapter-wallets');
  const solanaWallets = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];

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
