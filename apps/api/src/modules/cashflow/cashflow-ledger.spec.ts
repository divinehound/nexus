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
  opts: { tokenId?: string; wallet?: string } = {},
): LedgerMovement {
  return {
    chain: 'ethereum',
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

function fee(tx: string, iso: string, feeNative: number, wallet = ME): LedgerFee {
  return { chain: 'ethereum', txHash: tx, wallet, timestamp: new Date(iso), feeNative, symbol: 'ETH' };
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
});
