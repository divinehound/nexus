export function truncateAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

const CHAIN_CURRENCIES: Record<string, string> = {
  ethereum: 'ETH',
  base: 'ETH',
  abstract: 'ETH',
  apechain: 'APE',
  polygon: 'POL',
  robinhood: 'ETH',
  solana: 'SOL',
};

/** Get native currency symbol for a chain string */
export function chainCurrency(chain: string): string {
  return CHAIN_CURRENCIES[chain] ?? 'ETH';
}

export function formatPrice(price: number, currency = 'ETH'): string {
  return `${price.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${currency}`;
}

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

const EXPLORER_ADDRESS_URLS: Record<string, string> = {
  ethereum: 'https://etherscan.io/address/',
  base: 'https://basescan.org/address/',
  polygon: 'https://polygonscan.com/address/',
  abstract: 'https://explorer.abs.xyz/address/',
  apechain: 'https://apescan.io/address/',
  robinhood: 'https://robinhoodchain.blockscout.com/address/',
  solana: 'https://solscan.io/account/',
};

/** Block explorer page for a contract or account, or null for chains without one. */
export function explorerAddressUrl(chain: string, address: string): string | null {
  const base = EXPLORER_ADDRESS_URLS[chain.toLowerCase()];
  return base ? `${base}${address}` : null;
}
