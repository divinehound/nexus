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
    const primaryWallet = user.wallets?.[0];
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

  return <WalletFlow />;
}

function WalletFlow() {
  const [tab, setTab] = useState<WalletTab>('evm');
  const [showModal, setShowModal] = useState(false);
  const { isConnected } = useAccount();
  const { connected: solanaConnected } = useWallet();

  const walletConnected = (tab === 'evm' && isConnected) || (tab === 'solana' && solanaConnected);

  // Wallet connected but modal not open — show inline "Sign In" button
  if (walletConnected && !showModal) {
    return (
      <button
        onClick={() => setShowModal(true)}
        className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500"
      >
        Sign In
      </button>
    );
  }

  // Not connected — show connect buttons
  if (!showModal) {
    return (
      <div className="flex items-center gap-2">
        <RainbowConnectButton.Custom>
          {({ openConnectModal }) => (
            <button
              onClick={() => { setTab('evm'); openConnectModal(); }}
              className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500"
            >
              Connect Wallet
            </button>
          )}
        </RainbowConnectButton.Custom>
        <button
          onClick={() => { setTab('solana'); setShowModal(true); }}
          className="rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:border-gray-500 hover:text-white"
        >
          Solana
        </button>
      </div>
    );
  }

  // Sign-in modal
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setShowModal(false)} />
      <div className="fixed inset-0 z-[51] flex items-center justify-center">
        <div className="w-full max-w-md rounded-2xl border border-gray-700 bg-gray-900 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Sign In</h2>
            <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-white text-xl">
              &times;
            </button>
          </div>
          {tab === 'solana' && !solanaConnected ? (
            <SolanaConnect onSuccess={() => setShowModal(false)} />
          ) : tab === 'solana' && solanaConnected ? (
            <SolanaSign onSuccess={() => setShowModal(false)} />
          ) : (
            <EvmSign onSuccess={() => setShowModal(false)} />
          )}
        </div>
      </div>
    </>
  );
}

function EvmSign({ onSuccess }: { onSuccess: () => void }) {
  const { address } = useAccount();
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
  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <p className="mb-2 text-sm text-gray-400">Connect your Solana wallet first</p>
      <WalletMultiButton />
    </div>
  );
}

function SolanaSign({ onSuccess }: { onSuccess: () => void }) {
  const { publicKey, signMessage } = useWallet();
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
