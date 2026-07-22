import { PnlAccumulator, type PnlTransfer } from './wallet-pnl';

const d = (iso: string) => new Date(iso);

// Helper for the common no-fee case where buyer cost == seller proceeds.
const move = (
  tokenId: string,
  from: string,
  to: string,
  price: number | null,
  iso: string,
): PnlTransfer => ({
  tokenId,
  from,
  to,
  buyerCostNative: price,
  sellerProceedsNative: price,
  timestamp: d(iso),
});

describe('PnlAccumulator', () => {
  it('books realized profit on a buy then sell of the same token', () => {
    // ETH-style rates: 2000 USD on buy day, 2500 USD on sell day.
    const rates = new Map([
      ['2024-01-01', 2000],
      ['2024-02-01', 2500],
    ]);
    const acc = new PnlAccumulator(rates);
    const transfers: PnlTransfer[] = [
      move('T1', '', 'ALICE', 1, '2024-01-01T00:00:00Z'),
      move('T1', 'ALICE', 'BOB', 3, '2024-02-01T00:00:00Z'),
    ];
    transfers.forEach((t) => acc.recordTransfer(t));
    const rows = acc.finalize({ floorPriceNative: 4, spotUsdRate: 3000 });

    const alice = rows.find((r) => r.address === 'ALICE')!;
    expect(alice.buyCount).toBe(1);
    expect(alice.sellCount).toBe(1);
    expect(alice.realizedPnlNative).toBe(2); // 3 - 1
    expect(alice.realizedPnlUsd).toBe(3 * 2500 - 1 * 2000); // 5500
    expect(alice.totalBoughtNative).toBe(1);
    expect(alice.totalSoldNative).toBe(3);
    expect(alice.unrealizedPnlNative).toBe(0); // holds nothing
    expect(alice.avgHoldTimeSeconds).toBe(31 * 24 * 3600); // Jan 1 -> Feb 1

    // Bob now holds T1 at cost 3; floor 4 => +1 native unrealized.
    const bob = rows.find((r) => r.address === 'BOB')!;
    expect(bob.buyCount).toBe(1);
    expect(bob.sellCount).toBe(0);
    expect(bob.costBasisRemainingNative).toBe(3);
    expect(bob.unrealizedPnlNative).toBe(1); // 4 - 3
    expect(bob.unrealizedPnlUsd).toBe(4 * 3000 - 3 * 2500); // 12000 - 7500 = 4500
    expect(bob.avgHoldTimeSeconds).toBeNull();
  });

  it('treats an unpriced mint as zero cost basis', () => {
    const acc = new PnlAccumulator(new Map([['2024-01-01', 100]]));
    acc.recordTransfer(move('M1', '', 'ALICE', null, '2024-01-01T00:00:00Z'));
    acc.recordTransfer(move('M1', 'ALICE', 'BOB', 5, '2024-01-01T00:00:00Z'));
    const rows = acc.finalize({ floorPriceNative: 5, spotUsdRate: 100 });

    const alice = rows.find((r) => r.address === 'ALICE')!;
    expect(alice.buyCount).toBe(0); // mint was unpriced
    expect(alice.sellCount).toBe(1);
    expect(alice.realizedPnlNative).toBe(5); // proceeds 5 - cost 0
  });

  it('averages hold time across multiple realized tokens', () => {
    const acc = new PnlAccumulator(new Map());
    // Two tokens acquired same day, sold 2 and 4 days later respectively.
    acc.recordTransfer(move('A', '', 'W', 1, '2024-01-01T00:00:00Z'));
    acc.recordTransfer(move('B', '', 'W', 1, '2024-01-01T00:00:00Z'));
    acc.recordTransfer(move('A', 'W', 'X', 2, '2024-01-03T00:00:00Z'));
    acc.recordTransfer(move('B', 'W', 'Y', 2, '2024-01-05T00:00:00Z'));
    const rows = acc.finalize({ floorPriceNative: null, spotUsdRate: null });

    const w = rows.find((r) => r.address === 'W')!;
    expect(w.avgHoldTimeSeconds).toBe(((2 + 4) / 2) * 24 * 3600); // 3 days
    expect(w.realizedPnlNative).toBe(2); // (2-1) + (2-1)
    expect(w.unrealizedPnlNative).toBe(0); // holds nothing, and no floor anyway
  });

  it('leaves USD at zero when no rate is available for a date', () => {
    const acc = new PnlAccumulator(new Map()); // empty rate map
    acc.recordTransfer(move('T', '', 'A', 1, '2024-06-01T00:00:00Z'));
    acc.recordTransfer(move('T', 'A', 'B', 3, '2024-06-02T00:00:00Z'));
    const rows = acc.finalize({ floorPriceNative: 4, spotUsdRate: null });
    const a = rows.find((r) => r.address === 'A')!;
    expect(a.realizedPnlNative).toBe(2);
    expect(a.realizedPnlUsd).toBe(0); // native accurate, USD degraded to 0
    const b = rows.find((r) => r.address === 'B')!;
    expect(b.unrealizedPnlNative).toBe(1); // 4 - 3
    expect(b.unrealizedPnlUsd).toBe(0); // no spot rate
  });

  it('skips unrealized PnL when no floor price is provided', () => {
    const acc = new PnlAccumulator(new Map());
    acc.recordTransfer(move('T', '', 'A', 2, '2024-01-01T00:00:00Z'));
    const rows = acc.finalize({ floorPriceNative: null, spotUsdRate: 100 });
    const a = rows.find((r) => r.address === 'A')!;
    expect(a.costBasisRemainingNative).toBe(2);
    expect(a.unrealizedPnlNative).toBe(0);
  });

  it('deducts marketplace fees from seller proceeds while keeping buyer cost gross', () => {
    // Buyer pays 10 gross; seller nets 9 after a 1.0 marketplace fee + royalty.
    const acc = new PnlAccumulator(new Map());
    acc.recordTransfer(move('T', '', 'ALICE', 4, '2024-01-01T00:00:00Z')); // Alice mints at cost 4
    acc.recordTransfer({
      tokenId: 'T',
      from: 'ALICE',
      to: 'BOB',
      buyerCostNative: 10, // Bob's all-in cost basis
      sellerProceedsNative: 9, // Alice's net after fees
      timestamp: d('2024-01-02T00:00:00Z'),
    });
    const rows = acc.finalize({ floorPriceNative: 10, spotUsdRate: null });

    const alice = rows.find((r) => r.address === 'ALICE')!;
    // Realized on net proceeds (9), not gross (10): 9 - 4 = 5.
    expect(alice.realizedPnlNative).toBe(5);
    expect(alice.totalSoldNative).toBe(9);
    expect(alice.sellCount).toBe(1);

    const bob = rows.find((r) => r.address === 'BOB')!;
    // Bob's cost basis is the gross 10; floor 10 => 0 unrealized.
    expect(bob.costBasisRemainingNative).toBe(10);
    expect(bob.totalBoughtNative).toBe(10);
    expect(bob.unrealizedPnlNative).toBe(0);
  });
});
