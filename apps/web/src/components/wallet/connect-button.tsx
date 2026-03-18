'use client';

import { useState } from 'react';
import { ConnectButton as RainbowConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useSignMessage, useChainId } from 'wagmi';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { SiweMessage } from 'siwe';
import bs58 from 'bs58';
import { useAuth } from '@/context/auth-context';
import { truncateAddress } from '@/lib/utils';

type WalletTab = 'evm' | 'solana';

export function ConnectButton() {
  const { user, isLoading, logout } = useAuth();

  if (isLoading) {
    return (
      <div className="h-10 w-28 animate-pulse rounded-lg bg-gray-800" />
    );
  }

  if (user) {
    const primaryWallet = user.wallets[0];
    return (
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-300">
          {primaryWallet?.ensName || primaryWallet?.snsName || truncateAddress(primaryWallet?.address || '')}
        </span>
        <button
          onClick={logout}
          className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 transition-colors hover:border-gray-500 hover:text-white"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return <WalletModal />;
}

function WalletModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<WalletTab>('evm');

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500"
      >
        Connect Wallet
      </button>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-gray-700 bg-gray-900 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Connect Wallet</h2>
              <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-white">
                &times;
              </button>
            </div>
            <div className="mb-4 flex gap-2">
              <TabButton active={tab === 'evm'} onClick={() => setTab('evm')}>
                EVM
              </TabButton>
              <TabButton active={tab === 'solana'} onClick={() => setTab('solana')}>
                Solana
              </TabButton>
            </div>
            {tab === 'evm' ? (
              <EvmConnect onSuccess={() => setIsOpen(false)} />
            ) : (
              <SolanaConnect onSuccess={() => setIsOpen(false)} />
            )}
          </div>
        </div>
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
        active ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function EvmConnect({ onSuccess }: { onSuccess: () => void }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();
  const { loginEvm, getNonce } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  const handleSign = async () => {
    if (!address) return;
    setError(null);
    setSigning(true);
    try {
      const nonce = await getNonce(address);
      const message = new SiweMessage({
        domain: window.location.host,
        address,
        statement: 'Sign in to NEXUS with your Ethereum wallet.',
        uri: window.location.origin,
        version: '1',
        chainId,
        nonce,
      });
      const messageString = message.prepareMessage();
      const signature = await signMessageAsync({ message: messageString });
      await loginEvm(messageString, signature);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign in');
    } finally {
      setSigning(false);
    }
  };

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <p className="mb-2 text-sm text-gray-400">Connect your EVM wallet</p>
        <RainbowConnectButton />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <p className="text-sm text-gray-400">
        Connected: {truncateAddress(address || '')}
      </p>
      <button
        onClick={handleSign}
        disabled={signing}
        className="w-full rounded-lg bg-purple-600 py-3 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
      >
        {signing ? 'Signing...' : 'Sign In'}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

function SolanaConnect({ onSuccess }: { onSuccess: () => void }) {
  const { publicKey, signMessage, connected } = useWallet();
  const { loginSolana, getNonce } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  const handleSign = async () => {
    if (!publicKey || !signMessage) return;
    setError(null);
    setSigning(true);
    try {
      const address = publicKey.toBase58();
      const nonce = await getNonce(address);
      const message = `Sign this message to authenticate with NEXUS.\n\nNonce: ${nonce}`;
      const encodedMessage = new TextEncoder().encode(message);
      const signatureBytes = await signMessage(encodedMessage);
      const signature = bs58.encode(signatureBytes);

      await loginSolana(address, signature);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign in');
    } finally {
      setSigning(false);
    }
  };

  if (!connected) {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <p className="mb-2 text-sm text-gray-400">Connect your Solana wallet first</p>
        <WalletMultiButton />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <p className="text-sm text-gray-400">
        Connected: {truncateAddress(publicKey?.toBase58() || '')}
      </p>
      <button
        onClick={handleSign}
        disabled={signing}
        className="w-full rounded-lg bg-purple-600 py-3 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
      >
        {signing ? 'Signing...' : 'Sign In with Solana'}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
