import type { CashflowCategory, CashflowTxType } from '@nexus/types';

const usdFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

/** $1,234 — cents only under $100 so small gas figures stay meaningful. */
export function usd(n: number): string {
  if (n !== 0 && Math.abs(n) < 0.01) return n > 0 ? '<$0.01' : '−<$0.01';
  if (Math.abs(n) < 100) return usdCents.format(n);
  return usdFull.format(n);
}

export function usdShort(n: number): string {
  return Math.abs(n) < 1000 ? usdFull.format(n) : usdCompact.format(n);
}

/** Signed, for gains/losses: +$120 / −$45. The sign keeps meaning off color alone. */
export function usdSigned(n: number): string {
  if (Math.abs(n) < 0.005) return usd(0);
  return `${n > 0 ? '+' : '−'}${usd(Math.abs(n))}`;
}

export function pnlClass(n: number): string {
  if (Math.abs(n) < 0.005) return 'text-gray-400';
  return n > 0 ? 'text-green-400' : 'text-red-400';
}

export function qty(n: number): string {
  if (n === 0) return '0';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (Math.abs(n) >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return n.toPrecision(3);
}

export function monthLabel(month: string, style: 'short' | 'long' = 'short'): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: style === 'long' ? 'numeric' : '2-digit',
    timeZone: 'UTC',
  });
}

export const CATEGORY_LABELS: Record<CashflowCategory, string> = {
  nft_purchase: 'NFT purchases',
  nft_mint: 'NFT mints',
  token_purchase: 'Token buys',
  transfer_out: 'Sent to other wallets',
  gas_fees: 'Gas & network fees',
  nft_sale: 'NFT sales',
  token_sale: 'Token sales',
  transfer_in: 'Received from other wallets',
};

export const OUT_CATEGORIES: CashflowCategory[] = ['nft_purchase', 'nft_mint', 'token_purchase', 'transfer_out', 'gas_fees'];
export const IN_CATEGORIES: CashflowCategory[] = ['nft_sale', 'token_sale', 'transfer_in'];

export const TX_TYPE_LABELS: Record<CashflowTxType, string> = {
  nft_purchase: 'NFT buy',
  nft_mint: 'Mint',
  nft_sale: 'NFT sale',
  token_purchase: 'Token buy',
  token_sale: 'Token sale',
  swap: 'Swap',
  transfer_out: 'Sent',
  transfer_in: 'Received',
  received_asset: 'Received asset',
  sent_asset: 'Sent asset',
  own_wallet_transfer: 'Own wallets',
  contract_interaction: 'Gas only',
};

export const CHAIN_LABELS: Record<string, string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  abstract: 'Abstract',
  apechain: 'ApeChain',
  polygon: 'Polygon',
  solana: 'Solana',
};

export function txExplorerUrl(chain: string, hash: string): string | null {
  switch (chain) {
    case 'ethereum':
      return `https://etherscan.io/tx/${hash}`;
    case 'base':
      return `https://basescan.org/tx/${hash}`;
    case 'polygon':
      return `https://polygonscan.com/tx/${hash}`;
    case 'abstract':
      return `https://abscan.org/tx/${hash}`;
    case 'apechain':
      return `https://apescan.io/tx/${hash}`;
    case 'solana':
      return `https://solscan.io/tx/${hash}`;
    default:
      return null;
  }
}

export function addressExplorerUrl(chain: string, address: string): string | null {
  switch (chain) {
    case 'ethereum':
      return `https://etherscan.io/address/${address}`;
    case 'base':
      return `https://basescan.org/address/${address}`;
    case 'polygon':
      return `https://polygonscan.com/address/${address}`;
    case 'abstract':
      return `https://abscan.org/address/${address}`;
    case 'apechain':
      return `https://apescan.io/address/${address}`;
    case 'solana':
      return `https://solscan.io/account/${address}`;
    default:
      return null;
  }
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
