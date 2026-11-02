import { evmSalePrice } from './holder-history.service';

// Fixtures mirror Alchemy's raw getNFTSales response shape
// (nftSales[].sellerFee/protocolFee/royaltyFee.{amount,decimals}).
describe('evmSalePrice', () => {
  it('sums fees for gross (buyer cost) and uses sellerFee for net (seller proceeds)', () => {
    const sale = {
      tokenId: '1',
      transactionHash: '0xABC',
      sellerFee: { amount: '900000000000000000', decimals: 18, symbol: 'ETH' }, // 0.9
      protocolFee: { amount: '50000000000000000', decimals: 18 }, // 0.05
      royaltyFee: { amount: '50000000000000000', decimals: 18 }, // 0.05
    };
    const price = evmSalePrice(sale)!;
    expect(price).not.toBeNull();
    expect(price.sellerNet).toBeCloseTo(0.9, 9);
    expect(price.gross).toBeCloseTo(1.0, 9); // 0.9 + 0.05 + 0.05
  });

  it('returns gross == sellerNet when there is no protocol or royalty fee', () => {
    const sale = {
      tokenId: '2',
      transactionHash: '0xdef',
      sellerFee: { amount: '2000000000000000000', decimals: 18 }, // 2.0
    };
    const price = evmSalePrice(sale)!;
    expect(price.sellerNet).toBeCloseTo(2.0, 9);
    expect(price.gross).toBeCloseTo(2.0, 9);
  });

  it('returns null when the record has no fee amounts', () => {
    expect(evmSalePrice({ tokenId: '3', transactionHash: '0x1' })).toBeNull();
    expect(evmSalePrice({ sellerFee: {}, protocolFee: {}, royaltyFee: {} })).toBeNull();
  });

  it('honors per-fee decimals', () => {
    // A hypothetical 6-decimals payment token: amount 1500000 => 1.5
    const price = evmSalePrice({
      sellerFee: { amount: '1500000', decimals: 6 },
    })!;
    expect(price.sellerNet).toBeCloseTo(1.5, 9);
  });
});
