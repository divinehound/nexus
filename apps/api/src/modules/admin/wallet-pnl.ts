/**
 * Per-wallet PnL accumulation for a collection's holder transfer history.
 *
 * Fed one transfer at a time in chronological order (the same order the balance
 * history is replayed), it tracks each NFT's exact cost basis. Because NFTs are
 * non-fungible and identified by tokenId/mint, cost-basis matching is exact — no
 * FIFO/average-cost approximation is needed: we know precisely what price a wallet
 * paid for a specific token and what it later sold that same token for.
 *
 * Realized PnL = proceeds − cost basis, booked on disposal.
 * Unrealized PnL = collection floor − cost basis, marked at finalize() for tokens
 * still held.
 *
 * USD valuation uses the historical daily rate at each leg's date (via `dailyUsd`);
 * unrealized USD is marked at the current spot rate passed to finalize().
 */

export type PnlTransfer = {
  tokenId: string;
  from: string; // '' for a mint
  to: string; // '' for a burn
  priceNative: number | null; // sale/mint price in native token, null/0 when unpriced
  timestamp: Date;
};

export type WalletPnlResult = {
  address: string;
  buyCount: number;
  sellCount: number;
  realizedPnlNative: number;
  realizedPnlUsd: number;
  unrealizedPnlNative: number;
  unrealizedPnlUsd: number;
  totalBoughtNative: number;
  totalSoldNative: number;
  costBasisRemainingNative: number;
  avgHoldTimeSeconds: number | null;
};

type WalletState = {
  buyCount: number;
  sellCount: number;
  realizedNative: number;
  realizedUsd: number;
  totalBoughtNative: number;
  totalSoldNative: number;
  unrealizedNative: number;
  unrealizedUsd: number;
  costBasisRemainingNative: number;
  totalHoldSeconds: number;
  realizedDisposals: number;
};

type TokenState = {
  owner: string;
  costNative: number;
  costUsd: number;
  acquiredAt: Date;
};

export class PnlAccumulator {
  private readonly wallets = new Map<string, WalletState>();
  private readonly tokens = new Map<string, TokenState>();

  constructor(private readonly dailyUsd: Map<string, number>) {}

  /**
   * USD value of a native amount at a given date, using the cached daily rate.
   * Returns 0 when no rate is available so USD figures degrade gracefully while
   * native figures stay exact.
   */
  private usdAt(native: number, timestamp: Date): number {
    const rate = this.dailyUsd.get(timestamp.toISOString().slice(0, 10));
    return rate !== undefined ? native * rate : 0;
  }

  private ensureWallet(address: string): WalletState {
    let w = this.wallets.get(address);
    if (!w) {
      w = {
        buyCount: 0,
        sellCount: 0,
        realizedNative: 0,
        realizedUsd: 0,
        totalBoughtNative: 0,
        totalSoldNative: 0,
        unrealizedNative: 0,
        unrealizedUsd: 0,
        costBasisRemainingNative: 0,
        totalHoldSeconds: 0,
        realizedDisposals: 0,
      };
      this.wallets.set(address, w);
    }
    return w;
  }

  /** Record a single transfer. Disposal (seller) is booked before acquisition (buyer). */
  recordTransfer(t: PnlTransfer): void {
    const price = t.priceNative && t.priceNative > 0 ? t.priceNative : 0;
    const priceUsd = price > 0 ? this.usdAt(price, t.timestamp) : 0;

    // Disposal: the `from` wallet parts with the token.
    if (t.from) {
      const w = this.ensureWallet(t.from);
      const token = this.tokens.get(t.tokenId);
      // Unknown cost basis (token acquired before this history window) → treat as 0.
      const costNative = token?.costNative ?? 0;
      const costUsd = token?.costUsd ?? 0;
      w.realizedNative += price - costNative;
      w.realizedUsd += priceUsd - costUsd;
      w.totalSoldNative += price;
      if (price > 0) w.sellCount += 1;
      if (token) {
        const heldSeconds = Math.max(0, (t.timestamp.getTime() - token.acquiredAt.getTime()) / 1000);
        w.totalHoldSeconds += heldSeconds;
        w.realizedDisposals += 1;
      }
      this.tokens.delete(t.tokenId);
    }

    // Acquisition: the `to` wallet takes ownership; this price becomes its cost basis.
    if (t.to) {
      const w = this.ensureWallet(t.to);
      w.totalBoughtNative += price;
      if (price > 0) w.buyCount += 1;
      this.tokens.set(t.tokenId, {
        owner: t.to,
        costNative: price,
        costUsd: priceUsd,
        acquiredAt: t.timestamp,
      });
    }
  }

  /**
   * Close out still-held tokens against the current floor price and return the
   * per-wallet PnL rows. When `floorPriceNative` is null, unrealized PnL is left
   * at 0 (no reliable mark) but cost-basis-remaining is still reported.
   */
  finalize(opts: { floorPriceNative: number | null; spotUsdRate: number | null }): WalletPnlResult[] {
    const { floorPriceNative, spotUsdRate } = opts;

    for (const token of this.tokens.values()) {
      const w = this.ensureWallet(token.owner);
      w.costBasisRemainingNative += token.costNative;
      if (floorPriceNative != null) {
        w.unrealizedNative += floorPriceNative - token.costNative;
        if (spotUsdRate != null) {
          w.unrealizedUsd += floorPriceNative * spotUsdRate - token.costUsd;
        }
      }
    }

    const results: WalletPnlResult[] = [];
    for (const [address, w] of this.wallets.entries()) {
      results.push({
        address,
        buyCount: w.buyCount,
        sellCount: w.sellCount,
        realizedPnlNative: round(w.realizedNative),
        realizedPnlUsd: round(w.realizedUsd),
        unrealizedPnlNative: round(w.unrealizedNative),
        unrealizedPnlUsd: round(w.unrealizedUsd),
        totalBoughtNative: round(w.totalBoughtNative),
        totalSoldNative: round(w.totalSoldNative),
        costBasisRemainingNative: round(w.costBasisRemainingNative),
        avgHoldTimeSeconds:
          w.realizedDisposals > 0 ? Math.round(w.totalHoldSeconds / w.realizedDisposals) : null,
      });
    }
    return results;
  }
}

function round(n: number): number {
  // Keep enough precision for small native amounts (SOL/ETH) without float noise.
  return Math.round(n * 1e9) / 1e9;
}
