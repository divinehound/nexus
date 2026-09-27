import { buildCashflowReport, type LedgerAsset, type LedgerFee, type LedgerMovement, type UsdPricer } from './cashflow-ledger';

const ME = '0xme00000000000000000000000000000000000001';
const COLD = '0xcold000000000000000000000000000000000002';
const FRIEND = '0xfriend0000000000000000000000000000000003';
const MARKET = '0xmarket0000000000000000000000000000000004';

const ETH: LedgerAsset = { key: 'ethereum:native', chain: 'ethereum', kind: 'native', contract: '', name: 'Ether', symbol: 'ETH', price: { kind: 'native', symbol: 'ETH' } };
const USDC: LedgerAsset = { key: 'ethereum:usdc', chain: 'ethereum', kind: 'fungible', contract: 'usdc', name: 'USD Coin', symbol: 'USDC', price: { kind: 'usd' } };
const PUNKS: LedgerAsset = { key: 'ethereum:punks', chain: 'ethereum', kind: 'nft', contract: 'punks', name: 'Punks', symbol: null, price: null };
const PEPE: LedgerAsset = { key: 'ethereum:pepe', chain: 'ethereum', kind: 'fungible', contract: 'pepe', name: 'Pepe', symbol: 'PEPE', price: null };
const DOGE: LedgerAsset = { key: 'ethereum:doge', chain: 'ethereum', kind: 'fungible', contract: 'doge', name: 'Doge', symbol: 'DOGE', price: null };

// ETH = $2000 in Jan, $3000 in Feb.
const pricer: UsdPricer = {
  usdPerUnit: (ref, day) => (ref.kind === 'usd' ? 1 : day < '2024-02-01' ? 2000 : 3000),
};

function mv(
  tx: string,
  iso: string,
  direction: 'in' | 'out',
  asset: LedgerAsset,
  amount: number,
  counterparty: string,
  opts: { tokenId?: string; wallet?: string; chain?: string } = {},
): LedgerMovement {
  return {
    chain: opts.chain ?? 'ethereum',
    txHash: tx,
    timestamp: new Date(iso),
    wallet: opts.wallet ?? ME,
    direction,
    asset,
    tokenId: opts.tokenId ?? null,
    amount,
    counterparty,
  };
}

function fee(tx: string, iso: string, feeNative: number, wallet = ME, chain = 'ethereum'): LedgerFee {
  return { chain, txHash: tx, wallet, timestamp: new Date(iso), feeNative, symbol: 'ETH' };
}

function build(movements: LedgerMovement[], fees: LedgerFee[] = []) {
  return buildCashflowReport({
    movements,
    fees,
    wallets: [
      { chain: 'ethereum', address: ME },
      { chain: 'base', address: COLD.toUpperCase().replace('0X', '0x') },
    ],
    pricer,
    coverage: [],
    notes: [],
    now: new Date('2024-03-01T00:00:00Z'),
  });
}

describe('buildCashflowReport', () => {
  it('books an NFT buy then sale with realized profit per collection', () => {
    const r = build([
      mv('0xa', '2024-01-10T00:00:00Z', 'out', ETH, 1, MARKET),
      mv('0xa', '2024-01-10T00:00:00Z', 'in', PUNKS, 1, FRIEND, { tokenId: '7' }),
      mv('0xb', '2024-02-10T00:00:00Z', 'out', PUNKS, 1, FRIEND, { tokenId: '7' }),
      mv('0xb', '2024-02-10T00:00:00Z', 'in', ETH, 0.9, MARKET),
    ]);
    const punks = r.collections.find((c) => c.key === PUNKS.key)!;
    expect(punks.spentUsd).toBe(2000);
    expect(punks.proceedsUsd).toBeCloseTo(2700);
    expect(punks.realizedPnlUsd).toBeCloseTo(700);
    expect(punks.qtyHeld).toBe(0);
    expect(r.totals.outUsd).toBe(2000);
    expect(r.totals.inUsd).toBeCloseTo(2700);
    expect(r.totals.realizedPnlUsd).toBeCloseTo(700);
    expect(r.outByCategory.nft_purchase).toBe(2000);
    expect(r.inByCategory.nft_sale).toBeCloseTo(2700);
    expect(r.activity.map((a) => a.type)).toEqual(['nft_sale', 'nft_purchase']);
    expect(r.months.map((m) => m.month)).toEqual(['2024-01', '2024-02']);
  });

  it('classifies mints from the zero address and splits cost across tokens', () => {
    const r = build([
      mv('0xm', '2024-01-05T00:00:00Z', 'out', ETH, 0.2, MARKET),
      mv('0xm', '2024-01-05T00:00:00Z', 'in', PUNKS, 1, '', { tokenId: '1' }),
      mv('0xm', '2024-01-05T00:00:00Z', 'in', PUNKS, 1, '', { tokenId: '2' }),
      mv('0xs', '2024-01-20T00:00:00Z', 'out', PUNKS, 1, FRIEND, { tokenId: '2' }),
      mv('0xs', '2024-01-20T00:00:00Z', 'in', ETH, 0.1, MARKET),
    ]);
    const punks = r.collections[0];
    expect(r.outByCategory.nft_mint).toBeCloseTo(400);
    expect(punks.qtyHeld).toBe(1);
    expect(punks.openCostBasisUsd).toBeCloseTo(200);
    expect(punks.realizedPnlUsd).toBeCloseTo(0); // sold #2 for 200, basis 200
    expect(r.activity[1].label).toBe('Minted 2 × Punks for 0.2 ETH');
  });

  it('totals money sent to other wallets by counterparty', () => {
    const r = build([
      mv('0x1', '2024-01-01T00:00:00Z', 'out', ETH, 0.5, FRIEND),
      mv('0x2', '2024-02-01T00:00:00Z', 'out', USDC, 250, FRIEND),
      mv('0x3', '2024-02-02T00:00:00Z', 'in', USDC, 100, MARKET),
    ]);
    const friend = r.counterparties.find((c) => c.address === FRIEND)!;
    expect(friend.sentUsd).toBe(1250);
    expect(friend.sentCount).toBe(2);
    expect(r.outByCategory.transfer_out).toBe(1250);
    expect(r.inByCategory.transfer_in).toBe(100);
    expect(r.totals.netUsd).toBe(100 - 1250);
  });

  it('excludes transfers between linked wallets (EVM addresses match across chains/case)', () => {
    const r = build([
      mv('0x1', '2024-01-01T00:00:00Z', 'out', ETH, 2, COLD),
      mv('0x1', '2024-01-01T00:00:00Z', 'in', ETH, 2, ME, { wallet: COLD }),
    ], [fee('0x1', '2024-01-01T00:00:00Z', 0.001)]);
    expect(r.totals.inUsd).toBe(0);
    expect(r.outByCategory.transfer_out).toBeUndefined();
    expect(r.ownWalletTransfers).toEqual({ count: 1, usd: 4000 });
    // Gas is still a real cost.
    expect(r.totals.feesUsd).toBeCloseTo(2);
    expect(r.totals.outUsd).toBeCloseTo(2);
    expect(r.activity[0].type).toBe('own_wallet_transfer');
  });

  it('counts gas per chain and once per tx even if two linked wallets report it', () => {
    const r = build(
      [mv('0x1', '2024-01-01T00:00:00Z', 'out', ETH, 1, FRIEND)],
      [fee('0x1', '2024-01-01T00:00:00Z', 0.01), fee('0x1', '2024-01-01T00:00:00Z', 0.01, COLD), fee('0x9', '2024-02-01T00:00:00Z', 0.02)],
    );
    expect(r.fees).toEqual([{ chain: 'ethereum', symbol: 'ETH', feesNative: 0.03, feesUsd: 80, txCount: 2 }]);
    expect(r.activity.find((a) => a.txHash === '0x9')!.type).toBe('contract_interaction');
    expect(r.outByCategory.gas_fees).toBe(80);
    expect(r.totals.outUsd).toBe(2080);
  });

  it('nets refunds of the same asset within a tx', () => {
    const r = build([
      mv('0x1', '2024-01-01T00:00:00Z', 'out', ETH, 1, MARKET),
      mv('0x1', '2024-01-01T00:00:00Z', 'in', ETH, 0.25, MARKET),
      mv('0x1', '2024-01-01T00:00:00Z', 'in', PUNKS, 1, '', { tokenId: '1' }),
    ]);
    expect(r.collections[0].spentUsd).toBe(1500);
    expect(r.totals.inUsd).toBe(0);
  });

  it('uses average cost for fungibles and carries basis through token swaps', () => {
    const r = build([
      // Buy 100 PEPE for 1 ETH ($2000), then 100 more for 1 ETH ($3000) → avg $25.
      mv('0x1', '2024-01-01T00:00:00Z', 'out', ETH, 1, MARKET),
      mv('0x1', '2024-01-01T00:00:00Z', 'in', PEPE, 100, MARKET),
      mv('0x2', '2024-02-01T00:00:00Z', 'out', ETH, 1, MARKET),
      mv('0x2', '2024-02-01T00:00:00Z', 'in', PEPE, 100, MARKET),
      // Swap 100 PEPE → 50 DOGE: DOGE inherits $2500 basis.
      mv('0x3', '2024-02-02T00:00:00Z', 'out', PEPE, 100, MARKET),
      mv('0x3', '2024-02-02T00:00:00Z', 'in', DOGE, 50, MARKET),
      // Sell DOGE for 1 ETH ($3000) → +$500.
      mv('0x4', '2024-02-03T00:00:00Z', 'out', DOGE, 50, MARKET),
      mv('0x4', '2024-02-03T00:00:00Z', 'in', ETH, 1, MARKET),
    ]);
    const pepe = r.tokens.find((t) => t.key === PEPE.key)!;
    const doge = r.tokens.find((t) => t.key === DOGE.key)!;
    expect(pepe.qtyHeld).toBe(100);
    expect(pepe.openCostBasisUsd).toBeCloseTo(2500);
    expect(doge.realizedPnlUsd).toBeCloseTo(500);
    expect(r.activity.find((a) => a.txHash === '0x3')!.label).toBe('Swapped 100 PEPE → 50 DOGE');
  });

  it('treats a sale of something never bought as zero-basis and flags it', () => {
    const r = build([
      mv('0x1', '2024-01-01T00:00:00Z', 'in', PUNKS, 1, FRIEND, { tokenId: '9' }), // gift
      mv('0x2', '2024-02-01T00:00:00Z', 'out', PUNKS, 1, FRIEND, { tokenId: '5' }),
      mv('0x2', '2024-02-01T00:00:00Z', 'in', ETH, 1, MARKET),
    ]);
    const punks = r.collections[0];
    expect(punks.realizedPnlUsd).toBe(3000);
    expect(punks.qtySoldWithoutBasis).toBe(1);
    expect(r.activity.find((a) => a.txHash === '0x1')!.type).toBe('received_asset');
  });

  it('treats money-for-money swaps as conversions, not spending', () => {
    const r = build([
      mv('0x1', '2024-01-01T00:00:00Z', 'out', ETH, 1, MARKET),
      mv('0x1', '2024-01-01T00:00:00Z', 'in', USDC, 1990, MARKET),
    ]);
    expect(r.totals.inUsd).toBe(0);
    expect(r.totals.outUsd).toBe(0);
    expect(r.activity[0].type).toBe('swap');
  });

  it('counts unpriced money legs', () => {
    const r = buildCashflowReport({
      movements: [mv('0x1', '2024-01-01T00:00:00Z', 'out', ETH, 1, FRIEND)],
      fees: [],
      wallets: [{ chain: 'ethereum', address: ME }],
      pricer: { usdPerUnit: () => null },
      coverage: [],
      notes: [],
      now: new Date(),
    });
    expect(r.totals.unpricedMovements).toBe(1);
    expect(r.totals.outUsd).toBe(0);
  });

  describe('P/L after gas', () => {
    it('subtracts gas from the buy and the sale of what was sold', () => {
      const r = build(
        [
          mv('0xa', '2024-01-10T00:00:00Z', 'out', ETH, 1, MARKET),
          mv('0xa', '2024-01-10T00:00:00Z', 'in', PUNKS, 1, FRIEND, { tokenId: '7' }),
          mv('0xb', '2024-02-10T00:00:00Z', 'out', PUNKS, 1, FRIEND, { tokenId: '7' }),
          mv('0xb', '2024-02-10T00:00:00Z', 'in', ETH, 0.9, MARKET),
        ],
        // $20 gas to buy (Jan), $30 gas to sell (Feb).
        [fee('0xa', '2024-01-10T00:00:00Z', 0.01), fee('0xb', '2024-02-10T00:00:00Z', 0.01)],
      );
      const punks = r.collections[0];
      expect(punks.realizedPnlUsd).toBeCloseTo(700);
      expect(punks.realizedPnlAfterGasUsd).toBeCloseTo(650);
      expect(punks.gasUsd).toBeCloseTo(50);
      expect(r.totals.realizedPnlAfterGasUsd).toBeCloseTo(650);
      expect(r.months[1].realizedPnlAfterGasUsd).toBeCloseTo(650);
      // Gas still counts once in money out — not double-counted by the P/L view.
      expect(r.totals.feesUsd).toBeCloseTo(50);
    });

    it('only charges the mint gas share of the units sold; the rest stays with what you hold', () => {
      const r = build(
        [
          mv('0xm', '2024-01-05T00:00:00Z', 'out', ETH, 0.2, MARKET),
          mv('0xm', '2024-01-05T00:00:00Z', 'in', PUNKS, 1, '', { tokenId: '1' }),
          mv('0xm', '2024-01-05T00:00:00Z', 'in', PUNKS, 1, '', { tokenId: '2' }),
          mv('0xs', '2024-01-20T00:00:00Z', 'out', PUNKS, 1, FRIEND, { tokenId: '2' }),
          mv('0xs', '2024-01-20T00:00:00Z', 'in', ETH, 0.15, MARKET),
        ],
        // $40 mint gas across 2 tokens; $10 sale gas.
        [fee('0xm', '2024-01-05T00:00:00Z', 0.02), fee('0xs', '2024-01-20T00:00:00Z', 0.005)],
      );
      const punks = r.collections[0];
      expect(punks.realizedPnlUsd).toBeCloseTo(100); // 300 − 200
      expect(punks.realizedPnlAfterGasUsd).toBeCloseTo(70); // − 20 mint gas − 10 sale gas
      expect(punks.gasUsd).toBeCloseTo(50);
    });

    it('carries gas through token swaps into the eventual sale', () => {
      const r = build(
        [
          mv('0x1', '2024-01-01T00:00:00Z', 'out', ETH, 1, MARKET),
          mv('0x1', '2024-01-01T00:00:00Z', 'in', PEPE, 100, MARKET),
          mv('0x2', '2024-01-02T00:00:00Z', 'out', PEPE, 100, MARKET),
          mv('0x2', '2024-01-02T00:00:00Z', 'in', DOGE, 50, MARKET),
          mv('0x3', '2024-01-03T00:00:00Z', 'out', DOGE, 50, MARKET),
          mv('0x3', '2024-01-03T00:00:00Z', 'in', ETH, 1.5, MARKET),
        ],
        [fee('0x1', '2024-01-01T00:00:00Z', 0.001), fee('0x2', '2024-01-02T00:00:00Z', 0.001), fee('0x3', '2024-01-03T00:00:00Z', 0.001)],
      );
      const doge = r.tokens.find((t) => t.key === DOGE.key)!;
      expect(doge.realizedPnlUsd).toBeCloseTo(1000);
      expect(doge.realizedPnlAfterGasUsd).toBeCloseTo(994); // $2 × 3 txs
      expect(r.totals.realizedPnlAfterGasUsd).toBeCloseTo(994);
    });
  });

  describe('moves between your own wallets', () => {
    const BASE_ETH: LedgerAsset = { ...ETH, key: 'base:native', chain: 'base' };
    const SOL: LedgerAsset = { key: 'solana:native', chain: 'solana', kind: 'native', contract: '', name: 'Solana', symbol: 'SOL', price: { kind: 'native', symbol: 'SOL' } };
    const RELAY = '0xrelay00000000000000000000000000000000005';
    const SOLVER = '0xsolver0000000000000000000000000000000006';
    const PORTAL = '0xportal0000000000000000000000000000000007';
    const SOLME = 'SoLMe1111111111111111111111111111111111111';
    const t = (min: number) => new Date(Date.UTC(2024, 0, 10) + min * 60_000).toISOString();

    const buildWith = (movements: LedgerMovement[], fees: LedgerFee[] = [], pricerOverride?: UsdPricer) =>
      buildCashflowReport({
        movements,
        fees,
        wallets: [
          { chain: 'ethereum', address: ME },
          { chain: 'base', address: COLD },
          { chain: 'solana', address: SOLME },
        ],
        pricer: pricerOverride ?? pricer,
        coverage: [],
        notes: [],
        now: new Date('2024-03-01T00:00:00Z'),
      });

    it('treats a fast bridge (Ethereum → Base via a relayer) as a move, charging only the bridge fee', () => {
      const r = buildWith(
        [
          mv('0xl1', t(0), 'out', ETH, 1, RELAY),
          mv('0xl2', t(2), 'in', BASE_ETH, 0.995, SOLVER, { chain: 'base' }),
        ],
        [fee('0xl1', t(0), 0.001)],
      );
      expect(r.inByCategory.transfer_in).toBeUndefined();
      expect(r.outByCategory.transfer_out).toBeUndefined();
      expect(r.totals.inUsd).toBe(0);
      // $2 gas + $10 lost in the bridge.
      expect(r.totals.feesUsd).toBeCloseTo(12);
      expect(r.totals.outUsd).toBeCloseTo(12);
      expect(r.bridges).toEqual({ count: 1, usd: 2000, feesUsd: expect.closeTo(10) });
      expect(r.counterparties).toHaveLength(0);
      expect(r.activity.map((a) => a.type)).toEqual(['bridge', 'bridge']);
      expect(r.activity[1].label).toBe('Bridged 1 ETH · Ethereum → Base');
    });

    it('recognises a canonical deposit that lands on the same address on L2 (from = to = you)', () => {
      const r = buildWith(
        [
          mv('0xl1', t(0), 'out', ETH, 1, PORTAL),
          // The L2 deposit tx reports the L1 sender as `from`; no gas paid on L2.
          mv('0xl2', t(20), 'in', BASE_ETH, 1, ME, { chain: 'base' }),
        ],
        [fee('0xl1', t(0), 0.001)],
      );
      expect(r.totals.outUsd).toBeCloseTo(2);
      expect(r.totals.inUsd).toBe(0);
      expect(r.bridges.count).toBe(1);
      expect(r.ownWalletTransfers.count).toBe(0);
    });

    it('recognises a deposit to a different linked wallet whose L2 tx shows both of your wallets', () => {
      const r = buildWith([
        mv('0xl1', t(0), 'out', ETH, 1, PORTAL),
        mv('0xl2', t(20), 'out', BASE_ETH, 1, COLD, { chain: 'base', wallet: ME }),
        mv('0xl2', t(20), 'in', BASE_ETH, 1, ME, { chain: 'base', wallet: COLD }),
      ]);
      expect(r.totals.outUsd).toBe(0);
      expect(r.bridges.count).toBe(1);
    });

    it('matches slow canonical withdrawals (~7 days, full amount) but not stale coincidences', () => {
      const week = 7 * 24 * 60;
      const matched = buildWith([
        mv('0xw1', t(0), 'out', BASE_ETH, 2, PORTAL, { chain: 'base' }),
        mv('0xw2', t(week), 'in', ETH, 2, PORTAL),
      ]);
      expect(matched.bridges.count).toBe(1);
      expect(matched.totals.inUsd).toBe(0);

      const lossy = buildWith([
        mv('0xw1', t(0), 'out', BASE_ETH, 2, PORTAL, { chain: 'base' }),
        mv('0xw2', t(week), 'in', ETH, 1.9, FRIEND),
      ]);
      expect(lossy.bridges.count).toBe(0);

      const tooLate = buildWith([
        mv('0xw1', t(0), 'out', BASE_ETH, 2, PORTAL, { chain: 'base' }),
        mv('0xw2', t(3 * week), 'in', ETH, 2, PORTAL),
      ]);
      expect(tooLate.bridges.count).toBe(0);
    });

    it('matches cross-asset hops (SOL → ETH) on USD value', () => {
      const flat: UsdPricer = { usdPerUnit: (ref) => (ref.kind === 'usd' ? 1 : ref.symbol === 'SOL' ? 100 : 2000) };
      const r = buildWith(
        [
          { ...mv('sig1', t(0), 'out', SOL, 20, 'SoLRelay', { chain: 'solana', wallet: SOLME }) },
          mv('0xb', t(1), 'in', BASE_ETH, 0.99, SOLVER, { chain: 'base', wallet: COLD }),
        ],
        [],
        flat,
      );
      expect(r.bridges).toEqual({ count: 1, usd: 2000, feesUsd: expect.closeTo(20) });
      expect(r.totals.inUsd).toBe(0);
    });

    it("doesn't pair unrelated transfers of different sizes", () => {
      const r = buildWith([
        mv('0x1', t(0), 'out', ETH, 1, FRIEND),
        mv('0x2', t(5), 'in', BASE_ETH, 0.5, SOLVER, { chain: 'base' }),
      ]);
      expect(r.bridges.count).toBe(0);
      expect(r.outByCategory.transfer_out).toBe(2000);
      expect(r.inByCategory.transfer_in).toBe(1000);
    });

    it("doesn't pair transfers on the same chain", () => {
      const r = buildWith([
        mv('0x1', t(0), 'out', ETH, 1, FRIEND),
        mv('0x2', t(5), 'in', ETH, 1, SOLVER),
      ]);
      expect(r.bridges.count).toBe(0);
    });

    it('nets a same-tx hop between your wallets through a contract to zero', () => {
      const r = buildWith(
        [
          mv('0x1', t(0), 'out', ETH, 1, RELAY),
          mv('0x1', t(0), 'in', ETH, 1, RELAY, { wallet: COLD }),
        ],
        [fee('0x1', t(0), 0.001)],
      );
      expect(r.totals.inUsd).toBe(0);
      expect(r.totals.outUsd).toBeCloseTo(2);
    });

    it('does not treat a self-send you paid gas for as a bridge arrival', () => {
      const r = buildWith(
        [
          mv('0xl1', t(0), 'out', ETH, 1, FRIEND),
          mv('0xs', t(1), 'in', BASE_ETH, 1, ME, { chain: 'base' }),
        ],
        [fee('0xs', t(1), 0.0001, ME, 'base')],
      );
      expect(r.bridges.count).toBe(0);
      expect(r.outByCategory.transfer_out).toBe(2000);
    });
  });

  describe('linking transfers by hand or from bridge records', () => {
    const SOL: LedgerAsset = { key: 'solana:native', chain: 'solana', kind: 'native', contract: '', name: 'Solana', symbol: 'SOL', price: { kind: 'native', symbol: 'SOL' } };
    const SOLME = 'SoLMe1111111111111111111111111111111111111';
    const SIMPLESWAP = '0xsimpleswap00000000000000000000000000008';
    const flat: UsdPricer = { usdPerUnit: (ref) => (ref.kind === 'usd' ? 1 : ref.symbol === 'SOL' ? 100 : 2000) };
    const t = (min: number) => new Date(Date.UTC(2024, 0, 10) + min * 60_000).toISOString();
    // A slow, pricey swap service: 1 ETH ($2000) → 18 SOL ($1800) three hours later.
    const movements = () => [
      mv('0xeth', t(0), 'out', ETH, 1, SIMPLESWAP),
      mv('SoLsig', t(180), 'in', SOL, 18, 'SSHotWallet', { chain: 'solana', wallet: SOLME }),
    ];
    const run = (extra: Partial<Parameters<typeof buildCashflowReport>[0]>) =>
      buildCashflowReport({
        movements: movements(),
        fees: [],
        wallets: [
          { chain: 'ethereum', address: ME },
          { chain: 'solana', address: SOLME },
        ],
        pricer: flat,
        coverage: [],
        notes: [],
        now: new Date('2024-03-01T00:00:00Z'),
        ...extra,
      });

    it('leaves a slow cross-asset swap unmatched on its own', () => {
      const r = run({});
      expect(r.bridges.count).toBe(0);
      expect(r.outByCategory.transfer_out).toBe(2000);
    });

    it('treats a manually linked pair as one move and charges the difference as a fee', () => {
      const r = run({ explicitLinks: [{ fromChain: 'ethereum', fromTxHash: '0xETH', toChain: 'solana', toTxHash: 'SoLsig', source: 'manual' }] });
      expect(r.bridges).toEqual({ count: 1, usd: 2000, feesUsd: 200 });
      expect(r.totals.inUsd).toBe(0);
      expect(r.totals.outUsd).toBe(200);
      const out = r.activity.find((a) => a.chain === 'ethereum')!;
      expect(out).toMatchObject({ type: 'bridge', linkSource: 'manual', linkSide: 'out', linkedTo: { chain: 'solana', txHash: 'SoLsig' } });
    });

    it('applies bridge-service records the same way', () => {
      const r = run({ explicitLinks: [{ fromChain: 'ethereum', fromTxHash: '0xeth', toChain: 'solana', toTxHash: 'SoLsig', source: 'relay' }] });
      expect(r.activity.every((a) => a.linkSource === 'relay')).toBe(true);
    });

    it('lets the user reject an automatic match', () => {
      const BASE_ETH: LedgerAsset = { ...ETH, key: 'base:native', chain: 'base' };
      const base = {
        movements: [mv('0x1', t(0), 'out', ETH, 1, FRIEND), mv('0x2', t(2), 'in', BASE_ETH, 0.99, MARKET, { chain: 'base' })],
        fees: [],
        wallets: [{ chain: 'ethereum', address: ME }],
        pricer: flat,
        coverage: [],
        notes: [],
        now: new Date(),
      };
      expect(buildCashflowReport(base).bridges.count).toBe(1);
      const r = buildCashflowReport({ ...base, rejectedLinks: [{ fromChain: 'base', fromTxHash: '0x2', toChain: 'ethereum', toTxHash: '0x1' }] });
      expect(r.bridges.count).toBe(0);
      expect(r.outByCategory.transfer_out).toBe(2000);
    });
  });

  describe('exchanges', () => {
    const COINBASE_HOT = '0xc0ffee0000000000000000000000000000000001';
    const MY_DEPOSIT = '0xdeadbeef00000000000000000000000000000002';
    it('books exchange deposits/withdrawals as off-/on-ramps and nets them into "net invested"', () => {
      const r = buildCashflowReport({
        movements: [
          mv('0x1', '2024-01-01T00:00:00Z', 'in', ETH, 2, COINBASE_HOT),
          mv('0x2', '2024-01-05T00:00:00Z', 'out', USDC, 500, MY_DEPOSIT),
          mv('0x3', '2024-01-06T00:00:00Z', 'out', ETH, 0.1, FRIEND),
        ],
        fees: [],
        wallets: [{ chain: 'ethereum', address: ME }],
        pricer,
        coverage: [],
        notes: [],
        now: new Date(),
        exchangeAddresses: new Map([
          ['evm:' + COINBASE_HOT, { exchange: 'Coinbase', source: 'known' as const }],
          ['evm:' + MY_DEPOSIT, { exchange: 'Coinbase', source: 'detected' as const }],
        ]),
      });
      expect(r.inByCategory.exchange_withdrawal).toBe(4000);
      expect(r.outByCategory.exchange_deposit).toBe(500);
      expect(r.outByCategory.transfer_out).toBe(200);
      expect(r.totals).toMatchObject({ onRampUsd: 4000, offRampUsd: 500, netInvestedUsd: 3500 });
      expect(r.exchanges).toEqual([{ exchange: 'Coinbase', depositedUsd: 500, withdrawnUsd: 4000, txCount: 2 }]);
      expect(r.activity.find((a) => a.txHash === '0x2')).toMatchObject({ type: 'exchange_deposit', exchange: 'Coinbase', label: 'Cashed out 500 USDC to Coinbase' });
      expect(r.counterparties.find((c) => c.address === MY_DEPOSIT)).toMatchObject({ exchange: 'Coinbase', exchangeSource: 'detected' });
    });
  });

  describe('P/L in the native coin', () => {
    // ETH $4000 in January, $3000 in February.
    const ethDrop: UsdPricer = { usdPerUnit: (ref, day) => (ref.kind === 'usd' ? 1 : day < '2024-02-01' ? 4000 : 3000) };
    it('shows an ETH profit as a USD loss and splits it into trade gain vs price move', () => {
      const r = buildCashflowReport({
        movements: [
          mv('0xa', '2024-01-10T00:00:00Z', 'out', ETH, 1, MARKET),
          mv('0xa', '2024-01-10T00:00:00Z', 'in', PUNKS, 1, FRIEND, { tokenId: '7' }),
          mv('0xb', '2024-02-10T00:00:00Z', 'out', PUNKS, 1, FRIEND, { tokenId: '7' }),
          mv('0xb', '2024-02-10T00:00:00Z', 'in', ETH, 1.2, MARKET),
        ],
        fees: [],
        wallets: [{ chain: 'ethereum', address: ME }],
        pricer: ethDrop,
        coverage: [],
        notes: [],
        now: new Date(),
      });
      const punks = r.collections[0];
      expect(punks.realizedPnlUsd).toBeCloseTo(-400);
      expect(punks.nativeSymbol).toBe('ETH');
      expect(punks.spentNative).toBeCloseTo(1);
      expect(punks.proceedsNative).toBeCloseTo(1.2);
      expect(punks.realizedPnlNative).toBeCloseTo(0.2);
      expect(punks.tradeGainUsd).toBeCloseTo(600);
      expect(punks.priceMoveUsd).toBeCloseTo(-1000);
      expect(r.totals.realizedPnlNative).toEqual({ ETH: expect.closeTo(0.2) });
      expect(r.totals.tradeGainUsd).toBeCloseTo(600);
      expect(r.totals.priceMoveUsd).toBeCloseTo(-1000);
    });
  });
});
