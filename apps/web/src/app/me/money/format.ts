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

/** Signed amount of a chain's own coin: +0.2 ETH / −12.5 SOL. */
export function nativeAmount(n: number, symbol: string, signed = true): string {
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 3 : 4;
  const body = `${abs.toLocaleString('en-US', { maximumFractionDigits: digits })} ${symbol}`;
  if (!signed) return body;
  if (abs < 10 ** -digits) return `0 ${symbol}`;
  return `${n > 0 ? '+' : '−'}${body}`;
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
  exchange_deposit: 'Cashed out to exchanges',
  gas_fees: 'Gas, network & bridge fees',
  nft_sale: 'NFT sales',
  token_sale: 'Token sales',
  transfer_in: 'Received from other wallets',
  exchange_withdrawal: 'Deposited from exchanges',
};

export const OUT_CATEGORIES: CashflowCategory[] = ['nft_purchase', 'nft_mint', 'token_purchase', 'transfer_out', 'exchange_deposit', 'gas_fees'];
export const IN_CATEGORIES: CashflowCategory[] = ['nft_sale', 'token_sale', 'transfer_in', 'exchange_withdrawal'];

export const TX_TYPE_LABELS: Record<CashflowTxType, string> = {
  nft_purchase: 'NFT buy',
  nft_mint: 'Mint',
  nft_sale: 'NFT sale',
  token_purchase: 'Token buy',
  token_sale: 'Token sale',
  swap: 'Swap',
  transfer_out: 'Sent',
  transfer_in: 'Received',
  exchange_deposit: 'Cash out',
  exchange_withdrawal: 'Exchange deposit',
  received_asset: 'Received asset',
  sent_asset: 'Sent asset',
  own_wallet_transfer: 'Own wallets',
  bridge: 'Bridge',
  contract_interaction: 'Gas only',
};

export const CHAIN_LABELS: Record<string, string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  abstract: 'Abstract',
  apechain: 'ApeChain',
  polygon: 'Polygon',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  zora: 'Zora',
  blast: 'Blast',
  linea: 'Linea',
  solana: 'Solana',
};

const EXPLORERS: Record<string, { tx: string; address: string }> = {
  ethereum: { tx: 'https://etherscan.io/tx/', address: 'https://etherscan.io/address/' },
  base: { tx: 'https://basescan.org/tx/', address: 'https://basescan.org/address/' },
  polygon: { tx: 'https://polygonscan.com/tx/', address: 'https://polygonscan.com/address/' },
  abstract: { tx: 'https://abscan.org/tx/', address: 'https://abscan.org/address/' },
  apechain: { tx: 'https://apescan.io/tx/', address: 'https://apescan.io/address/' },
  arbitrum: { tx: 'https://arbiscan.io/tx/', address: 'https://arbiscan.io/address/' },
  optimism: { tx: 'https://optimistic.etherscan.io/tx/', address: 'https://optimistic.etherscan.io/address/' },
  zora: { tx: 'https://explorer.zora.energy/tx/', address: 'https://explorer.zora.energy/address/' },
  blast: { tx: 'https://blastscan.io/tx/', address: 'https://blastscan.io/address/' },
  linea: { tx: 'https://lineascan.build/tx/', address: 'https://lineascan.build/address/' },
  solana: { tx: 'https://solscan.io/tx/', address: 'https://solscan.io/account/' },
};

export function txExplorerUrl(chain: string, hash: string): string | null {
  const e = EXPLORERS[chain];
  return e ? `${e.tx}${hash}` : null;
}

export function addressExplorerUrl(chain: string, address: string): string | null {
  const e = EXPLORERS[chain];
  return e ? `${e.address}${address}` : null;
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
