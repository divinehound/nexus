'use client';

interface LinkWalletButtonProps {
  accessToken: string;
}

export function LinkWalletButton({ accessToken }: LinkWalletButtonProps) {
  const handleClick = () => {
    // Open link page in new window/tab with auth token
    const linkUrl = `/link-wallet?token=${encodeURIComponent(accessToken)}`;
    window.open(linkUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <button
      onClick={handleClick}
      className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500"
    >
      Link New Wallet
    </button>
  );
}
