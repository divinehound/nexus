import { runAllParsers, type ParserContext } from './solana-parsers';

const MINT = 'MintAddr111111111111111111111111111111111111';
const SELLER = 'Seller11111111111111111111111111111111111111';
const BUYER = 'Buyer111111111111111111111111111111111111111';

const ctx = (): ParserContext => ({ mintAddresses: new Set([MINT]) });

describe('solana-parsers price extraction', () => {
  it('extracts sale price (lamports) from an NFT_SALE event', () => {
    const tx = {
      timestamp: 1_700_000_000,
      slot: 100,
      events: {
        nft: {
          type: 'NFT_SALE',
          source: 'MAGIC_EDEN',
          seller: SELLER,
          buyer: BUYER,
          amount: 2_500_000_000, // 2.5 SOL
          nfts: [{ mint: MINT }],
        },
      },
    };
    const transfers = runAllParsers(tx, ctx());
    const sale = transfers.find((t) => t.fromWallet === SELLER && t.toWallet === BUYER);
    expect(sale).toBeDefined();
    expect(sale!.priceLamports).toBe(2_500_000_000);
  });

  it('splits the event amount evenly across multiple NFTs', () => {
    const MINT2 = 'Mint2Addr22222222222222222222222222222222222';
    const tx = {
      events: {
        nft: {
          type: 'NFT_SALE',
          seller: SELLER,
          buyer: BUYER,
          amount: 3_000_000_000,
          nfts: [{ mint: MINT }, { mint: MINT2 }],
        },
      },
    };
    const transfers = runAllParsers(tx, { mintAddresses: new Set([MINT, MINT2]) });
    expect(transfers).toHaveLength(2);
    expect(transfers[0].priceLamports).toBe(1_500_000_000);
    expect(transfers[1].priceLamports).toBe(1_500_000_000);
  });

  it('leaves price undefined for a non-sale event (bare transfer)', () => {
    const tx = {
      events: {
        nft: {
          type: 'TRANSFER',
          seller: SELLER,
          buyer: BUYER,
          nfts: [{ mint: MINT }],
        },
      },
    };
    const transfers = runAllParsers(tx, ctx());
    const t = transfers.find((x) => x.toWallet === BUYER);
    expect(t).toBeDefined();
    expect(t!.priceLamports).toBeUndefined();
  });

  it('does not emit a price when amount is zero', () => {
    const tx = {
      events: {
        nft: { type: 'NFT_SALE', seller: SELLER, buyer: BUYER, amount: 0, nfts: [{ mint: MINT }] },
      },
    };
    const transfers = runAllParsers(tx, ctx());
    const t = transfers.find((x) => x.toWallet === BUYER);
    expect(t!.priceLamports).toBeUndefined();
  });
});
