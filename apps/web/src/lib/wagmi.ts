import { connectorsForWallets, getDefaultConfig } from '@rainbow-me/rainbowkit';
import { type Config, createConfig, http } from 'wagmi';
import { mainnet, base, polygon } from 'wagmi/chains';
import { type Chain } from 'wagmi/chains';
import { abstractWallet } from '@abstract-foundation/agw-react/connectors';
import {
  coinbaseWallet,
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';

/**
 * Abstract chain definition
 */
export const abstract_chain = {
  id: 2741,
  name: 'Abstract',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://api.abstractions.io'] },
  },
  blockExplorers: {
    default: { name: 'Abstract Explorer', url: 'https://explorer.abs.xyz' },
  },
} as const satisfies Chain;

/**
 * ApeChain definition
 */
export const apechain = {
  id: 33139,
  name: 'ApeChain',
  nativeCurrency: { name: 'ApeCoin', symbol: 'APE', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.apechain.com'] },
  },
  blockExplorers: {
    default: { name: 'ApeChain Explorer', url: 'https://apescan.io' },
  },
} as const satisfies Chain;

export const supportedChains = [
  mainnet,
  base,
  polygon,
  abstract_chain,
  apechain,
] as const;

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_ID || 'nexus-dev';

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Popular',
      wallets: [
        metaMaskWallet,
        coinbaseWallet,       // Includes Base Smart Wallet support
        rainbowWallet,
        walletConnectWallet,
      ],
    },
    {
      groupName: 'Abstract',
      wallets: [
        abstractWallet,       // Abstract Global Wallet
      ],
    },
  ],
  { appName: 'NEXUS', projectId },
);

export const wagmiConfig: Config = createConfig({
  connectors,
  chains: supportedChains,
  transports: {
    [mainnet.id]: http(),
    [base.id]: http(),
    [polygon.id]: http(),
    [abstract_chain.id]: http(),
    [apechain.id]: http(),
  },
  ssr: true,
});
