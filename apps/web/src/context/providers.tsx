'use client';

import type { ReactNode } from 'react';
import { AuthProvider } from '@/context/auth-context';
import { wagmiConfig } from '@/lib/wagmi';
import '@rainbow-me/rainbowkit/styles.css';
import '@solana/wallet-adapter-react-ui/styles.css';

const solanaEndpoint = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

export function Providers({ children }: { children: ReactNode }) {
  // During SSR/prerender we must avoid importing wallet providers that touch
  // browser-only globals (indexedDB/window). Keep AuthProvider available so
  // hooks like useAuth still work in server-rendered routes.
  if (typeof window === 'undefined') {
    return <AuthProvider>{children}</AuthProvider>;
  }

  // Browser-only requires to prevent SSR evaluation side effects.
  const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
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

  const queryClient = new QueryClient();
  const solanaWallets = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme({ accentColor: '#a855f7' })}>
          <AbstractWalletProvider chain={'abstract' as any}>
            <ConnectionProvider endpoint={solanaEndpoint}>
              <SolanaWalletProvider wallets={solanaWallets} autoConnect>
                <AuthProvider>{children}</AuthProvider>
              </SolanaWalletProvider>
            </ConnectionProvider>
          </AbstractWalletProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
