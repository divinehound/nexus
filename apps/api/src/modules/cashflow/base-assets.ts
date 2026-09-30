/**
 * Assets we can put a USD value on without a token-price API: each chain's
 * native coin, its wrapped equivalents, and major USD stablecoins. Every other
 * token or NFT is valued by what was paid/received for it in these assets
 * within the same transaction.
 */

/** How to price one unit of an asset: via a native coin's daily USD rate, or pegged at $1. */
export type PriceRef = { kind: 'native'; symbol: string } | { kind: 'usd' };

interface KnownAsset {
  symbol: string;
  price: PriceRef;
}

const ETH: PriceRef = { kind: 'native', symbol: 'ETH' };
const USD: PriceRef = { kind: 'usd' };

/** Keyed by chain, then lowercased contract address (Solana mints are case-sensitive, stored as-is). */
const KNOWN_ASSETS: Record<string, Record<string, KnownAsset>> = {
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', price: ETH },
    // Blur Pool (BETH) — 1:1 ETH deposit used for Blur bids.
    '0x0000000000a39bb272e79075ade125fd351887ac': { symbol: 'BETH', price: ETH },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', price: USD },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', price: USD },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', price: USD },
  },
  base: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', price: ETH },
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', price: USD },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', price: USD },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', price: USD },
  },
  abstract: {
    '0x3439153eb7af838ad19d56e1571fbd09333c2809': { symbol: 'WETH', price: ETH },
    '0x84a71ccd554cc1b02749b35d22f684cc8ec987e1': { symbol: 'USDC.e', price: USD },
  },
  polygon: {
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH', price: ETH },
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': { symbol: 'WPOL', price: { kind: 'native', symbol: 'POL' } },
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', price: USD },
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': { symbol: 'USDC.e', price: USD },
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', price: USD },
  },
  apechain: {
    '0x48b62137edfa95a428d35c09e44256a739f6b557': { symbol: 'WAPE', price: { kind: 'native', symbol: 'APE' } },
    '0xcf800f4948d16f23333508191b1b1591daf70438': { symbol: 'ApeETH', price: ETH },
    '0xa2235d059f80e176d931ef76b6c51953eb3fbef4': { symbol: 'ApeUSD', price: USD },
  },
  arbitrum: {
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', price: ETH },
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', price: USD },
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { symbol: 'USDC.e', price: USD },
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', price: USD },
  },
  optimism: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', price: ETH },
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', price: USD },
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', price: USD },
  },
  zora: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', price: ETH },
  },
  blast: {
    '0x4300000000000000000000000000000000000004': { symbol: 'WETH', price: ETH },
    '0x4300000000000000000000000000000000000003': { symbol: 'USDB', price: USD },
  },
  robinhood: {
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73': { symbol: 'WETH', price: ETH },
    // Global Dollar (Paxos) — the chain's main stablecoin; Relay routes NFT buys through it.
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { symbol: 'USDG', price: USD },
  },
  arc: {
    // USDC's ERC-20 interface to the native coin (6 decimals); folded into native USDC when scanned.
    '0x3600000000000000000000000000000000000000': { symbol: 'USDC', price: USD },
  },
  linea: {
    '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f': { symbol: 'WETH', price: ETH },
    '0x176211869ca2b568f2a7d4ee941e073a821ee1ff': { symbol: 'USDC', price: USD },
  },
  solana: {
    So11111111111111111111111111111111111111112: { symbol: 'wSOL', price: { kind: 'native', symbol: 'SOL' } },
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', price: USD },
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', price: USD },
  },
};

export function knownAsset(chain: string, contract: string): KnownAsset | null {
  const table = KNOWN_ASSETS[chain];
  if (!table) return null;
  return table[chain === 'solana' ? contract : contract.toLowerCase()] ?? null;
}

const NATIVE_SYMBOL: Record<string, string> = { polygon: 'POL', apechain: 'APE', arc: 'USDC', solana: 'SOL' };

/** Native coins that are dollars (Arc pays gas in USDC): always worth $1. */
export const USD_NATIVE_SYMBOLS = new Set(['USDC']);

/** The coin a chain's gas and native transfers are denominated in (ETH for Ethereum and its L2s). */
export function nativeSymbolFor(chain: string): string {
  return NATIVE_SYMBOL[chain] ?? 'ETH';
}
