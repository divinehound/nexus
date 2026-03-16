export function truncateAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function formatPrice(price: number, currency = 'ETH'): string {
  return `${price.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${currency}`;
}

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
