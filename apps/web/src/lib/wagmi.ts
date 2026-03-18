import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { type Config } from 'wagmi';
import { mainnet } from 'wagmi/chains';

export const wagmiConfig: Config = getDefaultConfig({
  appName: 'NEXUS',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_ID || 'nexus-dev',
  chains: [mainnet],
  ssr: true,
});
