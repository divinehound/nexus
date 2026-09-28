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
  async getDailyUsdRates(
    token: NativeToken,
    fromDate: Date,
    toDate: Date,
  ): Promise<Map<string, number>> {
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

    const toInsert: Array<typeof tokenPriceDaily.$inferInsert> = [];
    const fill = (prices: Map<string, number>, source: string) => {
      for (const day of missing) {
        const price = prices.get(day);
        if (price === undefined || rates.has(day)) continue;
        rates.set(day, price);
        toInsert.push({ symbol, date: day, usdPrice: price, source });
      }
    };

    fill(await this.fetchRangeFromCoinGecko(coinId, fromDate, toDate), 'coingecko');

    // CoinGecko's free tier only serves the last 365 days (and rejects longer
    // ranges outright). Fill whatever is still missing from Coinbase's public
    // daily candles, which go back years and need no key.
    const stillMissing = missing.filter((d) => !rates.has(d));
    if (stillMissing.length > 0 && COINBASE_PRODUCTS[symbol]) {
      const from = new Date(`${stillMissing[0]}T00:00:00Z`);
      const to = new Date(`${stillMissing[stillMissing.length - 1]}T00:00:00Z`);
      fill(await this.fetchRangeFromCoinbase(symbol, from, to), 'coinbase');
    }

    if (toInsert.length > 0) {
      await this.db.insert(tokenPriceDaily).values(toInsert).onConflictDoNothing();
    }
    if (rates.size === 0) {
      this.logger.warn(
        `No USD rates available for ${symbol} (${fromKey}..${toKey}); USD PnL will be 0`,
      );
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
  private async fetchRangeFromCoinGecko(
    coinId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<Map<string, number>> {
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

  /**
   * Daily closes from Coinbase Exchange's public candles endpoint
   * (max 300 candles per request, so long ranges are fetched in windows).
   * Products are tried in order — POL traded as MATIC before its rename.
   */
  private async fetchRangeFromCoinbase(
    symbol: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const product of COINBASE_PRODUCTS[symbol] ?? []) {
      try {
        for (const [start, end] of coinbaseWindows(fromDate, toDate)) {
          const url = new URL(`https://api.exchange.coinbase.com/products/${product}/candles`);
          url.searchParams.set('granularity', '86400');
          url.searchParams.set('start', start.toISOString());
          url.searchParams.set('end', end.toISOString());
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 20000);
          try {
            // Coinbase rejects requests without a User-Agent.
            const res = await fetch(url.toString(), {
              headers: { accept: 'application/json', 'user-agent': 'nexus-price-oracle' },
              signal: controller.signal,
            });
            if (res.status === 404) break; // product didn't exist — try the next name
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            for (const [day, price] of parseCoinbaseCandles(await res.json())) {
              if (!result.has(day)) result.set(day, price);
            }
          } finally {
            clearTimeout(timer);
          }
          await new Promise((r) => setTimeout(r, 150)); // public limit is ~10 req/s
        }
      } catch (err) {
        this.logger.warn(`Coinbase candles fetch failed for ${product}: ${(err as Error).message}`);
      }
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
    const cursor = new Date(
      Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate()),
    );
    const end = new Date(
      Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate()),
    );
    while (cursor <= end) {
      days.push(toDayKey(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }
}

/** Coinbase Exchange products for each native token we price, tried in order. */
const COINBASE_PRODUCTS: Record<string, string[]> = {
  ETH: ['ETH-USD'],
  SOL: ['SOL-USD'],
  APE: ['APE-USD'],
  POL: ['POL-USD', 'MATIC-USD'],
};

const DAY_MS = 86_400_000;
const COINBASE_MAX_CANDLES = 300;

/** Split [from, to] into windows of at most 300 daily candles. */
export function coinbaseWindows(fromDate: Date, toDate: Date): Array<[Date, Date]> {
  const windows: Array<[Date, Date]> = [];
  let start = Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate());
  const end = Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate());
  while (start <= end) {
    const windowEnd = Math.min(end, start + (COINBASE_MAX_CANDLES - 1) * DAY_MS);
    windows.push([new Date(start), new Date(windowEnd + DAY_MS - 1000)]);
    start = windowEnd + DAY_MS;
  }
  return windows;
}

/** Coinbase candles are `[time, low, high, open, close, volume]` with `time` in seconds; keep the close per UTC day. */
export function parseCoinbaseCandles(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(json)) return out;
  for (const row of json) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [time, , , , close] = row;
    if (typeof time !== 'number' || typeof close !== 'number' || !(close > 0)) continue;
    out.set(toDayKey(new Date(time * 1000)), close);
  }
  return out;
}
