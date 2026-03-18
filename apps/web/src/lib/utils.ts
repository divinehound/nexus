export function truncateAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

const CHAIN_CURRENCIES: Record<string, string> = {
  ethereum: 'ETH',
  base: 'ETH',
  abstract: 'ETH',
  apechain: 'APE',
  polygon: 'POL',
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
