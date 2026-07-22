import { PnlAccumulator, type PnlTransfer } from './wallet-pnl';

const d = (iso: string) => new Date(iso);

describe('PnlAccumulator', () => {
  it('books realized profit on a buy then sell of the same token', () => {
    // ETH-style rates: 2000 USD on buy day, 2500 USD on sell day.
    const rates = new Map([
      ['2024-01-01', 2000],
      ['2024-02-01', 2500],
    ]);
    const acc = new PnlAccumulator(rates);
    const transfers: PnlTransfer[] = [
      { tokenId: 'T1', from: '', to: 'ALICE', priceNative: 1, timestamp: d('2024-01-01T00:00:00Z') },
      { tokenId: 'T1', from: 'ALICE', to: 'BOB', priceNative: 3, timestamp: d('2024-02-01T00:00:00Z') },
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
    acc.recordTransfer({ tokenId: 'M1', from: '', to: 'ALICE', priceNative: null, timestamp: d('2024-01-01T00:00:00Z') });
    acc.recordTransfer({ tokenId: 'M1', from: 'ALICE', to: 'BOB', priceNative: 5, timestamp: d('2024-01-01T00:00:00Z') });
    const rows = acc.finalize({ floorPriceNative: 5, spotUsdRate: 100 });

    const alice = rows.find((r) => r.address === 'ALICE')!;
    expect(alice.buyCount).toBe(0); // mint was unpriced
    expect(alice.sellCount).toBe(1);
    expect(alice.realizedPnlNative).toBe(5); // proceeds 5 - cost 0
  });

  it('averages hold time across multiple realized tokens', () => {
    const acc = new PnlAccumulator(new Map());
    // Two tokens acquired same day, sold 2 and 4 days later respectively.
    acc.recordTransfer({ tokenId: 'A', from: '', to: 'W', priceNative: 1, timestamp: d('2024-01-01T00:00:00Z') });
    acc.recordTransfer({ tokenId: 'B', from: '', to: 'W', priceNative: 1, timestamp: d('2024-01-01T00:00:00Z') });
    acc.recordTransfer({ tokenId: 'A', from: 'W', to: 'X', priceNative: 2, timestamp: d('2024-01-03T00:00:00Z') });
    acc.recordTransfer({ tokenId: 'B', from: 'W', to: 'Y', priceNative: 2, timestamp: d('2024-01-05T00:00:00Z') });
    const rows = acc.finalize({ floorPriceNative: null, spotUsdRate: null });

    const w = rows.find((r) => r.address === 'W')!;
    expect(w.avgHoldTimeSeconds).toBe(((2 + 4) / 2) * 24 * 3600); // 3 days
    expect(w.realizedPnlNative).toBe(2); // (2-1) + (2-1)
    expect(w.unrealizedPnlNative).toBe(0); // holds nothing, and no floor anyway
  });

  it('leaves USD at zero when no rate is available for a date', () => {
    const acc = new PnlAccumulator(new Map()); // empty rate map
    acc.recordTransfer({ tokenId: 'T', from: '', to: 'A', priceNative: 1, timestamp: d('2024-06-01T00:00:00Z') });
    acc.recordTransfer({ tokenId: 'T', from: 'A', to: 'B', priceNative: 3, timestamp: d('2024-06-02T00:00:00Z') });
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
    acc.recordTransfer({ tokenId: 'T', from: '', to: 'A', priceNative: 2, timestamp: d('2024-01-01T00:00:00Z') });
    const rows = acc.finalize({ floorPriceNative: null, spotUsdRate: 100 });
    const a = rows.find((r) => r.address === 'A')!;
    expect(a.costBasisRemainingNative).toBe(2);
    expect(a.unrealizedPnlNative).toBe(0);
  });
});
