'use client';

import { useEffect, useState, useRef } from 'react';
import { AuthGate } from '@/components/wallet/auth-gate';
import { useAuth } from '@/context/auth-context';
import { apiFetch } from '@/lib/api';
import { truncateAddress } from '@/lib/utils';

interface EchoScore {
  walletAddress: string;
  echoScore: number | null;
  label: string | null;
}

export default function EchoCardPage() {
  return (
    <AuthGate>
      <EchoCardContent />
    </AuthGate>
  );
}

function EchoCardContent() {
  const { user } = useAuth();
  const address = user?.wallets[0]?.address;
  const [echoScore, setEchoScore] = useState<EchoScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!address) return;
    apiFetch<EchoScore>(`/discovery/echo-score/${address}`)
      .then(setEchoScore)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [address]);

  const shareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/me/card`
    : '';

  const shareText = echoScore?.echoScore !== null
    ? `My NEXUS Echo Chamber Score: ${echoScore?.echoScore}/100 (${echoScore?.label}). How insular is your NFT portfolio?`
    : '';

  const handleCopyLink = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShareTwitter = () => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`;
    window.open(url, '_blank');
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
          <span className="text-gray-400">Generating your score card...</span>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-3xl font-bold">Echo Chamber Score Card</h1>

      {/* Score Card */}
      <div className="mt-8 flex justify-center">
        <div
          ref={cardRef}
          className="w-full max-w-md rounded-2xl border border-gray-700 bg-gradient-to-br from-gray-900 via-gray-900 to-purple-900/30 p-8"
        >
          <div className="text-center">
            <p className="text-sm font-medium uppercase tracking-wider text-purple-400">NEXUS</p>
            <p className="mt-1 text-xs text-gray-500">Echo Chamber Score</p>
          </div>

          <div className="mt-6 flex justify-center">
            <div className={`flex h-32 w-32 items-center justify-center rounded-full text-5xl font-bold ${
              (echoScore?.echoScore ?? 0) >= 70 ? 'bg-red-900/40 text-red-400 ring-2 ring-red-500/30' :
              (echoScore?.echoScore ?? 0) >= 40 ? 'bg-yellow-900/40 text-yellow-400 ring-2 ring-yellow-500/30' :
              'bg-green-900/40 text-green-400 ring-2 ring-green-500/30'
            }`}>
              {echoScore?.echoScore ?? '?'}
            </div>
          </div>

          <div className="mt-4 text-center">
            <p className="text-xl font-semibold">{echoScore?.label ?? 'Unknown'}</p>
            <p className="mt-2 text-sm text-gray-400">
              {(echoScore?.echoScore ?? 0) >= 70
                ? 'Deep in the echo chamber. Your communities are tightly knit.'
                : (echoScore?.echoScore ?? 0) >= 40
                ? 'Balanced portfolio. You have a healthy mix of communities.'
                : 'Trailblazer! You explore far beyond the usual circles.'}
            </p>
          </div>

          <div className="mt-6 border-t border-gray-800 pt-4 text-center">
            <p className="text-xs text-gray-500">
              {user?.wallets[0]?.ensName || user?.wallets[0]?.snsName || truncateAddress(address || '')}
            </p>
          </div>
        </div>
      </div>

      {/* Share Buttons */}
      <div className="mt-6 flex justify-center gap-3">
        <button
          onClick={handleShareTwitter}
          className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium transition-colors hover:bg-gray-700"
        >
          Share on Twitter/X
        </button>
        <button
          onClick={handleCopyLink}
          className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 transition-colors hover:border-gray-500 hover:text-white"
        >
          {copied ? 'Copied!' : 'Copy Link'}
        </button>
      </div>
    </main>
  );
}
