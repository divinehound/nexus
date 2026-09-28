import { PriceOracleService, coinbaseWindows, parseCoinbaseCandles } from './price-oracle.service';

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

describe('coinbaseWindows', () => {
  it('splits long ranges into ≤300-day windows that cover every day once', () => {
    const w = coinbaseWindows(new Date('2021-01-01T00:00:00Z'), new Date('2022-12-31T00:00:00Z'));
    expect(w.length).toBe(3); // 730 days
    const days = w.reduce(
      (n, [s, e]) => n + Math.round((e.getTime() + 1000 - s.getTime()) / 86_400_000),
      0,
    );
    expect(days).toBe(730);
    expect(w[0][0].toISOString()).toBe('2021-01-01T00:00:00.000Z');
    expect(w[1][0].getTime()).toBeGreaterThan(w[0][1].getTime());
  });
});

describe('parseCoinbaseCandles', () => {
  it('keeps the close ([time, low, high, open, close, volume]) per UTC day', () => {
    const m = parseCoinbaseCandles([
      [day('2021-06-02'), 2400, 2800, 2500, 2700, 100],
      [day('2021-06-01'), 2300, 2700, 2600, 2550, 90],
      ['bad'],
    ]);
    expect([...m.entries()]).toEqual([
      ['2021-06-02', 2700],
      ['2021-06-01', 2550],
    ]);
    expect(parseCoinbaseCandles({ message: 'NotFound' }).size).toBe(0);
  });
});

describe('PriceOracleService.getDailyUsdRates', () => {
  afterEach(() => jest.restoreAllMocks());

  function makeService() {
    const inserted: Array<{ date: string; usdPrice: number; source: string }> = [];
    const db = {
      query: { tokenPriceDaily: { findMany: async () => [], findFirst: async () => null } },
      insert: () => ({
        values: (rows: typeof inserted) => ({
          onConflictDoNothing: async () => {
            inserted.push(...rows);
          },
        }),
      }),
    };
    const config = { get: () => '' };
    return { svc: new PriceOracleService(db as never, config as never), inserted };
  }

  it('fills days CoinGecko refuses (free tier, >1 year old) from Coinbase and caches them', async () => {
    const urls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('coingecko'))
        return new Response('{"error":"exceeds the allowed time range"}', { status: 401 });
      return new Response(
        JSON.stringify([
          [day('2021-03-02'), 1, 1, 1, 1500, 1],
          [day('2021-03-01'), 1, 1, 1, 1450, 1],
        ]),
        { status: 200 },
      );
    });
    const { svc, inserted } = makeService();
    const rates = await svc.getDailyUsdRates(
      { symbol: 'ETH', coinId: 'ethereum' },
      new Date('2021-03-01'),
      new Date('2021-03-02'),
    );
    expect(rates.get('2021-03-01')).toBe(1450);
    expect(rates.get('2021-03-02')).toBe(1500);
    expect(inserted.map((r) => r.source)).toEqual(['coinbase', 'coinbase']);
    const cb = urls.filter((u) => u.includes('coinbase'));
    expect(cb[0]).toContain('/products/ETH-USD/candles');
    expect(cb[0]).toContain('granularity=86400');
  });

  it('falls back to MATIC-USD for POL history before the rename', async () => {
    const products: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('coingecko')) return new Response('{}', { status: 401 });
      const product = url.split('/products/')[1].split('/')[0];
      products.push(product);
      if (product === 'POL-USD') return new Response('{"message":"NotFound"}', { status: 404 });
      return new Response(JSON.stringify([[day('2022-05-01'), 1, 1, 1, 1.2, 1]]), { status: 200 });
    });
    const { svc } = makeService();
    const rates = await svc.getDailyUsdRates(
      { symbol: 'POL', coinId: 'polygon-ecosystem-token' },
      new Date('2022-05-01'),
      new Date('2022-05-01'),
    );
    expect(products).toEqual(['POL-USD', 'MATIC-USD']);
    expect(rates.get('2022-05-01')).toBe(1.2);
  });

  it('prefers CoinGecko where it has data and does not call Coinbase then', async () => {
    const urls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({ prices: [[Date.parse('2026-09-01T12:00:00Z'), 2500]] }),
        { status: 200 },
      );
    });
    const { svc, inserted } = makeService();
    const rates = await svc.getDailyUsdRates(
      { symbol: 'ETH', coinId: 'ethereum' },
      new Date('2026-09-01'),
      new Date('2026-09-01'),
    );
    expect(rates.get('2026-09-01')).toBe(2500);
    expect(inserted[0].source).toBe('coingecko');
    expect(urls.some((u) => u.includes('coinbase'))).toBe(false);
  });
});
