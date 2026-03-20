'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { AuthGate } from '@/components/wallet/auth-gate';
import { useAuth } from '@/context/auth-context';
import {
  ApiError,
  LinkedWallet,
  MeResponse,
  createWalletChallenge,
  getMe,
  getMyHoldingsCollections,
  getMyHoldingsSummary,
  HoldingsCollectionItem,
  HoldingsSummaryResponse,
  moveWalletLink,
  patchMyProfile,
  removeWallet,
  setPrimaryWallet,
  verifyWalletLink,
} from '@/lib/api';
import { truncateAddress } from '@/lib/utils';

interface ProfileFormState {
  displayName: string;
  avatarUrl: string;
  bio: string;
}

interface MoveConfirmationState {
  chain: string;
  address: string;
  confirmationToken: string;
}

export default function MePage() {
  return (
    <AuthGate>
      <MePageContent />
    </AuthGate>
  );
}

function MePageContent() {
  const { accessToken } = useAuth();
  const { address: connectedAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { publicKey: solanaPublicKey, signMessage: signSolanaMessage } = useWallet();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [wallets, setWallets] = useState<LinkedWallet[]>([]);
  const [holdingsSummary, setHoldingsSummary] = useState<HoldingsSummaryResponse | null>(null);
  const [topActiveCollections, setTopActiveCollections] = useState<HoldingsCollectionItem[]>([]);
  const [profileForm, setProfileForm] = useState<ProfileFormState>({ displayName: '', avatarUrl: '', bio: '' });

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [profileSaving, setProfileSaving] = useState(false);
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [walletActionId, setWalletActionId] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  const [addChain, setAddChain] = useState('ethereum');
  const [addAddress, setAddAddress] = useState('');
  const [addWalletLoading, setAddWalletLoading] = useState(false);
  const [addWalletSuccess, setAddWalletSuccess] = useState<string | null>(null);
  const [addWalletError, setAddWalletError] = useState<string | null>(null);

  const [moveConfirmation, setMoveConfirmation] = useState<MoveConfirmationState | null>(null);
  const [moveLoading, setMoveLoading] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  const hasToken = Boolean(accessToken);

  const profileDisplayName = useMemo(() => me?.displayName || 'Unnamed user', [me?.displayName]);

  const fetchMe = async () => {
    if (!accessToken) return;

    const [meData, summary, activeCollections] = await Promise.all([
      getMe(accessToken),
      getMyHoldingsSummary(accessToken),
      getMyHoldingsCollections(accessToken, 'active', 1, 5),
    ]);

    setMe(meData);
    setWallets(meData.wallets || []);
    setHoldingsSummary(summary);
    setTopActiveCollections(activeCollections.items || []);
    setProfileForm({
      displayName: meData.displayName || '',
      avatarUrl: meData.avatarUrl || '',
      bio: meData.bio || '',
    });
  };

  useEffect(() => {
    if (!accessToken) return;

    setLoading(true);
    setLoadError(null);

    fetchMe()
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load your profile');
      })
      .finally(() => setLoading(false));
  }, [accessToken]);

  const onSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (!accessToken) return;

    setProfileSaving(true);
    setProfileError(null);
    setProfileStatus(null);

    try {
      const updated = await patchMyProfile(
        {
          displayName: profileForm.displayName.trim() || undefined,
          avatarUrl: profileForm.avatarUrl.trim() || undefined,
          bio: profileForm.bio.trim() || undefined,
        },
        accessToken,
      );
      setMe(updated);
      setWallets(updated.wallets || wallets);
      setProfileStatus('Profile saved');
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setProfileSaving(false);
    }
  };

  const onSetPrimary = async (walletId: string) => {
    if (!accessToken) return;
    setWalletError(null);
    setWalletActionId(walletId);

    try {
      await setPrimaryWallet(walletId, accessToken);
      await fetchMe();
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : 'Failed to set primary wallet');
    } finally {
      setWalletActionId(null);
    }
  };

  const onRemoveWallet = async (walletId: string) => {
    if (!accessToken) return;
    setWalletError(null);
    setWalletActionId(walletId);

    try {
      await removeWallet(walletId, accessToken);
      await fetchMe();
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : 'Failed to remove wallet');
    } finally {
      setWalletActionId(null);
    }
  };

  const signWalletChallenge = async (chain: string, message: string) => {
    if (chain === 'solana') {
      if (!signSolanaMessage) {
        throw new Error('Connected Solana wallet cannot sign messages. Use a wallet that supports signMessage.');
      }
      const signatureBytes = await signSolanaMessage(new TextEncoder().encode(message));
      return bs58.encode(signatureBytes);
    }

    return signMessageAsync({ message });
  };

  const onAddWallet = async (e: FormEvent) => {
    e.preventDefault();
    if (!accessToken) return;

    const normalizedAddress = addChain === 'solana' ? addAddress.trim() : addAddress.trim().toLowerCase();
    if (!normalizedAddress) {
      setAddWalletError('Wallet address is required');
      return;
    }

    if (addChain === 'solana' && !signSolanaMessage) {
      setAddWalletError('Connected Solana wallet cannot sign messages. Use a wallet that supports signMessage.');
      return;
    }

    setAddWalletLoading(true);
    setAddWalletError(null);
    setAddWalletSuccess(null);

    try {
      const challenge = await createWalletChallenge(
        { chain: addChain, address: normalizedAddress, purpose: 'link_wallet' },
        accessToken,
      );

      const signature = await signWalletChallenge(addChain, challenge.message);
      const verifyResult = await verifyWalletLink(
        {
          chain: addChain,
          address: normalizedAddress,
          message: challenge.message,
          signature,
        },
        accessToken,
      );

      await fetchMe();
      setAddWalletSuccess(
        verifyResult.idempotent
          ? 'Wallet already linked to your account'
          : 'Wallet linked successfully',
      );
      setAddAddress('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data?.error === 'WALLET_ALREADY_LINKED' && err.data?.confirmationToken) {
        setMoveConfirmation({
          chain: addChain,
          address: normalizedAddress,
          confirmationToken: err.data.confirmationToken,
        });
      } else {
        setAddWalletError(err instanceof Error ? err.message : 'Failed to link wallet');
      }
    } finally {
      setAddWalletLoading(false);
    }
  };

  const onConfirmWalletMove = async () => {
    if (!accessToken || !moveConfirmation) return;

    setMoveLoading(true);
    setMoveError(null);

    try {
      if (moveConfirmation.chain === 'solana' && !signSolanaMessage) {
        throw new Error('Connected Solana wallet cannot sign messages. Use a wallet that supports signMessage.');
      }

      const challenge = await createWalletChallenge(
        {
          chain: moveConfirmation.chain,
          address: moveConfirmation.address,
          purpose: 'move_wallet',
          confirmationToken: moveConfirmation.confirmationToken,
        },
        accessToken,
      );
      const signature = await signWalletChallenge(moveConfirmation.chain, challenge.message);

      await moveWalletLink(
        {
          chain: moveConfirmation.chain,
          address: moveConfirmation.address,
          confirmationToken: moveConfirmation.confirmationToken,
          message: challenge.message,
          signature,
        },
        accessToken,
      );

      await fetchMe();
      setMoveConfirmation(null);
      setAddWalletSuccess('Wallet moved and linked to your account');
      setAddAddress('');
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : 'Failed to move wallet');
    } finally {
      setMoveLoading(false);
    }
  };

  if (!hasToken) {
    return null;
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-gray-400">Loading profile...</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-red-400">{loadError}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl space-y-8 px-4 py-8">
      <section className="rounded-xl border border-gray-800 p-6">
        <h1 className="text-2xl font-semibold">My Identity</h1>
        <p className="mt-1 text-sm text-gray-400">Current display name: {profileDisplayName}</p>

        <form className="mt-6 space-y-4" onSubmit={onSaveProfile}>
          <label className="block space-y-1">
            <span className="text-sm text-gray-300">Display name</span>
            <input
              value={profileForm.displayName}
              onChange={(e) => {
                setProfileForm((prev) => ({ ...prev, displayName: e.target.value }));
                setProfileStatus(null);
                setProfileError(null);
              }}
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
              placeholder={me?.displayName || 'Display name'}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-sm text-gray-300">Avatar URL</span>
            <input
              value={profileForm.avatarUrl}
              onChange={(e) => {
                setProfileForm((prev) => ({ ...prev, avatarUrl: e.target.value }));
                setProfileStatus(null);
                setProfileError(null);
              }}
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
              placeholder="https://..."
            />
          </label>

          <label className="block space-y-1">
            <span className="text-sm text-gray-300">Bio</span>
            <textarea
              value={profileForm.bio}
              onChange={(e) => {
                setProfileForm((prev) => ({ ...prev, bio: e.target.value }));
                setProfileStatus(null);
                setProfileError(null);
              }}
              className="h-24 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
              placeholder="Tell people who you are"
            />
          </label>

          <button
            type="submit"
            disabled={profileSaving}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-60"
          >
            {profileSaving ? 'Saving...' : 'Save profile'}
          </button>

          {profileStatus && <p className="text-sm text-green-400">{profileStatus}</p>}
          {profileError && <p className="text-sm text-red-400">{profileError}</p>}
        </form>
      </section>

      <section className="rounded-xl border border-gray-800 p-6">
        <h2 className="text-xl font-semibold">Holdings Tracking</h2>
        <p className="mt-1 text-sm text-gray-400">
          Suppressed collections are hidden from main discovery surfaces, but still retained for auditability and future review.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-gray-800 p-3">
            <p className="text-xs text-gray-500">Active tracked</p>
            <p className="mt-1 text-xl font-semibold">{holdingsSummary?.tiers.active ?? 0}</p>
          </div>
          <div className="rounded-lg border border-gray-800 p-3">
            <p className="text-xs text-gray-500">Lightweight tracked</p>
            <p className="mt-1 text-xl font-semibold">{holdingsSummary?.tiers.lightweight ?? 0}</p>
          </div>
          <div className="rounded-lg border border-gray-800 p-3">
            <p className="text-xs text-gray-500">Suppressed</p>
            <p className="mt-1 text-xl font-semibold">{holdingsSummary?.tiers.suppressed ?? 0}</p>
          </div>
          <div className="rounded-lg border border-gray-800 p-3">
            <p className="text-xs text-gray-500">Last indexed</p>
            <p className="mt-1 text-sm font-medium text-gray-200">
              {holdingsSummary?.lastIndexedAt ? new Date(holdingsSummary.lastIndexedAt).toLocaleString() : 'Never'}
            </p>
          </div>
        </div>

        <div className="mt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Top Active Collections</h3>
          <div className="mt-3 space-y-2">
            {topActiveCollections.length === 0 ? (
              <p className="text-sm text-gray-500">No active tracked collections yet.</p>
            ) : (
              topActiveCollections.map((collection) => (
                <div key={collection.id} className="rounded-lg border border-gray-800 p-3">
                  <p className="text-sm font-medium text-white">{collection.name}</p>
                  <p className="text-xs text-gray-500">
                    {collection.chain.toUpperCase()} • {truncateAddress(collection.contractAddress)} • Tokens: {collection.tokenCount}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-gray-800 p-6">
        <h2 className="text-xl font-semibold">Linked Wallets</h2>

        <div className="mt-4 space-y-2">
          {wallets.length === 0 ? (
            <p className="text-sm text-gray-500">No linked wallets.</p>
          ) : (
            wallets.map((wallet) => (
              <div key={wallet.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-800 p-3">
                <div>
                  <p className="text-sm font-medium text-white">
                    {wallet.chain.toUpperCase()} {truncateAddress(wallet.address)}
                    {wallet.isPrimary && <span className="ml-2 text-xs text-green-400">PRIMARY</span>}
                  </p>
                  <p className="text-xs text-gray-500">{wallet.address}</p>
                </div>
                <div className="flex items-center gap-2">
                  {!wallet.isPrimary && (
                    <button
                      onClick={() => onSetPrimary(wallet.id)}
                      disabled={walletActionId === wallet.id}
                      className="rounded-md border border-gray-700 px-3 py-1.5 text-xs text-gray-200 hover:border-gray-500 disabled:opacity-60"
                    >
                      Set Primary
                    </button>
                  )}
                  <button
                    onClick={() => onRemoveWallet(wallet.id)}
                    disabled={walletActionId === wallet.id}
                    className="rounded-md border border-red-800 px-3 py-1.5 text-xs text-red-300 hover:border-red-600 disabled:opacity-60"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {walletError && <p className="mt-3 text-sm text-red-400">{walletError}</p>}
      </section>

      <section className="rounded-xl border border-gray-800 p-6">
        <h2 className="text-xl font-semibold">Add Wallet</h2>
        <p className="mt-1 text-sm text-gray-400">EVM flow: challenge to signature to verify</p>

        <form className="mt-4 space-y-3" onSubmit={onAddWallet}>
          <label className="block space-y-1">
            <span className="text-sm text-gray-300">Chain</span>
            <select
              value={addChain}
              onChange={(e) => setAddChain(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
            >
              <option value="ethereum">Ethereum</option>
              <option value="base">Base</option>
              <option value="polygon">Polygon</option>
              <option value="solana">Solana</option>
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-sm text-gray-300">Wallet address</span>
            <input
              value={addAddress}
              onChange={(e) => setAddAddress(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
              placeholder={addChain === 'solana' ? 'Solana base58 address' : '0x...'}
            />
          </label>

          {addChain === 'solana' ? (
            solanaPublicKey && (
              <button
                type="button"
                className="text-xs text-purple-400 hover:text-purple-300"
                onClick={() => setAddAddress(solanaPublicKey.toBase58())}
              >
                Use connected wallet ({truncateAddress(solanaPublicKey.toBase58())})
              </button>
            )
          ) : (
            connectedAddress && (
              <button
                type="button"
                className="text-xs text-purple-400 hover:text-purple-300"
                onClick={() => setAddAddress(connectedAddress)}
              >
                Use connected wallet ({truncateAddress(connectedAddress)})
              </button>
            )
          )}

          <div>
            <button
              type="submit"
              disabled={addWalletLoading}
              className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-60"
            >
              {addWalletLoading ? 'Linking...' : 'Link wallet'}
            </button>
          </div>

          {addWalletSuccess && <p className="text-sm text-green-400">{addWalletSuccess}</p>}
          {addWalletError && <p className="text-sm text-red-400">{addWalletError}</p>}
        </form>
      </section>

      {moveConfirmation && (
        <>
          <div className="fixed inset-0 z-50 bg-black/70" />
          <div className="fixed inset-0 z-[51] flex items-center justify-center px-4">
            <div className="w-full max-w-lg rounded-xl border border-gray-700 bg-gray-900 p-6">
              <h3 className="text-lg font-semibold">Confirm Wallet Move</h3>
              <p className="mt-2 text-sm text-gray-300">
                This wallet is linked to another account. Confirm to transfer ownership to your current account.
              </p>
              <p className="mt-2 text-xs text-gray-500">Wallet: {moveConfirmation.address}</p>

              <div className="mt-6 flex gap-2">
                <button
                  className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-gray-500"
                  onClick={() => {
                    if (moveLoading) return;
                    setMoveConfirmation(null);
                    setMoveError(null);
                  }}
                  disabled={moveLoading}
                >
                  Cancel
                </button>
                <button
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-60"
                  onClick={onConfirmWalletMove}
                  disabled={moveLoading}
                >
                  {moveLoading ? 'Confirming...' : 'Confirm Transfer'}
                </button>
              </div>

              {moveError && <p className="mt-3 text-sm text-red-400">{moveError}</p>}
            </div>
          </div>
        </>
      )}
    </main>
  );
}
