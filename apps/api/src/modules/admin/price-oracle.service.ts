import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gte, lte } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, tokenPriceDaily } from '@nexus/database';

/**
 * Native token metadata per chain: the ticker we key the price cache on, and
 * the CoinGecko coin id used to fetch USD rates.
 */
const CHAIN_NATIVE_TOKEN: Record<string, { symbol: string; coinId: string }> = {
  ethereum: { symbol: 'ETH', coinId: 'ethereum' },
  base: { symbol: 'ETH', coinId: 'ethereum' },
  abstract: { symbol: 'ETH', coinId: 'ethereum' },
  polygon: { symbol: 'POL', coinId: 'matic-network' },
  apechain: { symbol: 'APE', coinId: 'apecoin' },
  solana: { symbol: 'SOL', coinId: 'solana' },
};

export type NativeToken = { symbol: string; coinId: string };

export function nativeTokenForChain(chain: string): NativeToken {
  return CHAIN_NATIVE_TOKEN[chain] ?? { symbol: chain.toUpperCase().slice(0, 16), coinId: chain };
}

/** Format a Date as a UTC 'YYYY-MM-DD' day key. */
export function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Historical + spot USD prices for native tokens, backed by a DB cache
 * (`token_price_daily`). PnL valuation reads the daily rate at each transfer's
 * date; the cache means repeated scans don't re-hit the external API.
 *
 * All network access is best-effort: if CoinGecko is unavailable or no data is
 * returned, callers still get whatever is cached (possibly empty) and native-token
 * PnL remains fully accurate — only USD valuation degrades.
 */
@Injectable()
export class PriceOracleService {
  private readonly logger = new Logger(PriceOracleService.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  /**
   * Return a map of 'YYYY-MM-DD' -> USD price for `symbol` covering
   * [fromDate, toDate] inclusive. Missing days are fetched from CoinGecko in a
   * single range call and written back to the cache.
   */
  async getDailyUsdRates(token: NativeToken, fromDate: Date, toDate: Date): Promise<Map<string, number>> {
    const { symbol, coinId } = token;
    const fromKey = toDayKey(fromDate);
    const toKey = toDayKey(toDate);

    const rates = new Map<string, number>();
    const cached = await this.db.query.tokenPriceDaily.findMany({
      where: and(
        eq(tokenPriceDaily.symbol, symbol),
        gte(tokenPriceDaily.date, fromKey),
        lte(tokenPriceDaily.date, toKey),
      ),
    });
    for (const row of cached) rates.set(row.date, row.usdPrice);

    // Which days in the range are still missing from the cache?
    const missing = this.enumerateDays(fromDate, toDate).filter((d) => !rates.has(d));
    if (missing.length === 0) return rates;

    const fetched = await this.fetchRangeFromCoinGecko(coinId, fromDate, toDate);
    if (fetched.size === 0) {
      if (rates.size === 0) {
        this.logger.warn(`No USD rates available for ${symbol} (${fromKey}..${toKey}); USD PnL will be 0`);
      }
      return rates;
    }

    const toInsert: Array<typeof tokenPriceDaily.$inferInsert> = [];
    for (const day of missing) {
      const price = fetched.get(day);
      if (price === undefined) continue;
      rates.set(day, price);
      toInsert.push({ symbol, date: day, usdPrice: price, source: 'coingecko' });
    }
    if (toInsert.length > 0) {
      await this.db.insert(tokenPriceDaily).values(toInsert).onConflictDoNothing();
    }
    return rates;
  }

  /** Current USD spot price for a token, used to mark unrealized PnL. */
  async getSpotUsd(token: NativeToken): Promise<number | null> {
    const { coinId } = token;
    try {
      const url = new URL(`${this.baseUrl()}/simple/price`);
      url.searchParams.set('ids', coinId);
      url.searchParams.set('vs_currencies', 'usd');
      const json = await this.getJson(url);
      const price = json?.[coinId]?.usd;
      if (typeof price === 'number' && price > 0) return price;
    } catch (err) {
      this.logger.warn(`Spot USD fetch failed for ${coinId}: ${(err as Error).message}`);
    }
    // Fall back to the most recent cached daily rate.
    const latest = await this.db.query.tokenPriceDaily.findFirst({
      where: eq(tokenPriceDaily.symbol, token.symbol),
      orderBy: (t, { desc }) => [desc(t.date)],
    });
    return latest?.usdPrice ?? null;
  }

  /**
   * Fetch a date range from CoinGecko's market_chart/range endpoint and reduce
   * the (hourly or daily) points to a single USD price per UTC day (last point
   * of the day wins).
   */
  private async fetchRangeFromCoinGecko(coinId: string, fromDate: Date, toDate: Date): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      // Pad by a day on each side so day-boundary points are captured.
      const fromSec = Math.floor(fromDate.getTime() / 1000) - 86400;
      const toSec = Math.floor(toDate.getTime() / 1000) + 86400;
      const url = new URL(`${this.baseUrl()}/coins/${coinId}/market_chart/range`);
      url.searchParams.set('vs_currency', 'usd');
      url.searchParams.set('from', String(fromSec));
      url.searchParams.set('to', String(toSec));

      const json = await this.getJson(url);
      const prices: Array<[number, number]> = json?.prices ?? [];
      for (const [ms, price] of prices) {
        if (typeof ms !== 'number' || typeof price !== 'number') continue;
        result.set(toDayKey(new Date(ms)), price);
      }
    } catch (err) {
      this.logger.warn(`CoinGecko range fetch failed for ${coinId}: ${(err as Error).message}`);
    }
    return result;
  }

  private baseUrl(): string {
    return 'https://api.coingecko.com/api/v3';
  }

  private async getJson(url: URL): Promise<any> {
    const apiKey = this.config.get<string>('coingecko.apiKey');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey) headers['x-cg-demo-api-key'] = apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url.toString(), { headers, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Inclusive list of 'YYYY-MM-DD' day keys between two dates (UTC). */
  private enumerateDays(fromDate: Date, toDate: Date): string[] {
    const days: string[] = [];
    const cursor = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate()));
    const end = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate()));
    while (cursor <= end) {
      days.push(toDayKey(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }
}
