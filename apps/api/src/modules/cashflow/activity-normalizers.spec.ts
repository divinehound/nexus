import type { LedgerAsset } from './cashflow-ledger';
import { normalizeEvmTransfer, type AlchemyTransfer } from './evm-activity.fetcher';
import { normalizeSolanaTx, type MintInfo } from './solana-activity.fetcher';
import { nearestDay } from './cashflow.service';

const ME = '0xAbC0000000000000000000000000000000000001';
const OTHER = '0xdef0000000000000000000000000000000000002';
const ZERO = '0x0000000000000000000000000000000000000000';
const ts = new Date('2024-01-01T00:00:00Z');

const transfer = (t: Partial<AlchemyTransfer>): AlchemyTransfer => ({
  blockNum: '0x1',
  hash: '0xhash',
  from: OTHER,
  to: ME.toLowerCase(),
  value: null,
  asset: null,
  category: 'external',
  ...t,
});

describe('normalizeEvmTransfer', () => {
  it('reads native value from the raw hex amount and flags direction case-insensitively', () => {
    const assets = new Map<string, LedgerAsset>();
    const [m] = normalizeEvmTransfer('base', ME, transfer({ from: ME, to: OTHER, rawContract: { value: '0x0de0b6b3a7640000', address: null, decimal: '0x12' } }), ts, assets);
    expect(m).toMatchObject({ direction: 'out', amount: 1, counterparty: OTHER, tokenId: null });
    expect(m.asset).toMatchObject({ kind: 'native', symbol: 'ETH', price: { kind: 'native', symbol: 'ETH' } });
  });

  it('prices known stablecoins and wrapped native, leaves other ERC-20s unpriced', () => {
    const assets = new Map<string, LedgerAsset>();
    const usdc = normalizeEvmTransfer('ethereum', ME, transfer({ category: 'erc20', asset: 'USDC', rawContract: { value: '0x5f5e100', address: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimal: '0x6' } }), ts, assets)[0];
    expect(usdc.amount).toBe(100);
    expect(usdc.asset.price).toEqual({ kind: 'usd' });
    const weth = normalizeEvmTransfer('base', ME, transfer({ category: 'erc20', asset: 'WETH', rawContract: { value: '0x1', address: '0x4200000000000000000000000000000000000006', decimal: '0x12' } }), ts, assets)[0];
    expect(weth.asset.price).toEqual({ kind: 'native', symbol: 'ETH' });
    const pepe = normalizeEvmTransfer('ethereum', ME, transfer({ category: 'erc20', asset: 'PEPE', rawContract: { value: '0x64', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933', decimal: '0x0' } }), ts, assets)[0];
    expect(pepe.asset.price).toBeNull();
    expect(pepe.amount).toBe(100);
  });

  it('turns mints into zero-counterparty NFT movements with decimal token ids', () => {
    const [m] = normalizeEvmTransfer('ethereum', ME, transfer({ from: ZERO, category: 'erc721', erc721TokenId: '0x2a', rawContract: { value: null, address: '0xNFT', decimal: null } }), ts, new Map());
    expect(m).toMatchObject({ direction: 'in', counterparty: '', tokenId: '42', amount: 1 });
    expect(m.asset.kind).toBe('nft');
  });

  it('keeps from = to = you as an arrival from yourself (same-address bridge deposits)', () => {
    const [m] = normalizeEvmTransfer('base', ME, transfer({ from: ME, to: ME, rawContract: { value: '0x0de0b6b3a7640000', address: null, decimal: '0x12' } }), ts, new Map());
    expect(m).toMatchObject({ direction: 'in', counterparty: ME.toLowerCase(), amount: 1 });
  });

  it('expands ERC-1155 batches', () => {
    const ms = normalizeEvmTransfer('ethereum', ME, transfer({ category: 'erc1155', erc1155Metadata: [{ tokenId: '0x1', value: '0x3' }, { tokenId: '0x2', value: '0x1' }], rawContract: { value: null, address: '0xe', decimal: null } }), ts, new Map());
    expect(ms.map((m) => [m.tokenId, m.amount])).toEqual([['1', 3], ['2', 1]]);
  });
});

describe('normalizeSolanaTx', () => {
  const WALLET = 'Wa11et1111111111111111111111111111111111111';
  const BUYER = 'Buyer111111111111111111111111111111111111111';

  it('books SOL, NFT legs grouped by collection, and the fee when the wallet paid it', () => {
    const info = new Map<string, MintInfo>([['MintA', { isNft: true, name: 'Mad Lad #12', symbol: 'MAD', collection: 'CollX', collectionName: 'Mad Lads' }]]);
    const assets = new Map<string, LedgerAsset>();
    const { movements, fee } = normalizeSolanaTx(
      WALLET,
      {
        signature: 'sig1',
        timestamp: 1_700_000_000,
        fee: 5000,
        feePayer: WALLET,
        nativeTransfers: [{ fromUserAccount: BUYER, toUserAccount: WALLET, amount: 2_500_000_000 }],
        tokenTransfers: [{ fromUserAccount: WALLET, toUserAccount: BUYER, tokenAmount: 1, mint: 'MintA', tokenStandard: 'ProgrammableNonFungible' }],
      },
      info,
      assets,
    );
    expect(fee?.feeNative).toBeCloseTo(0.000005);
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({ direction: 'in', amount: 2.5, counterparty: BUYER });
    expect(movements[1]).toMatchObject({ direction: 'out', tokenId: 'MintA' });
    expect(movements[1].asset).toMatchObject({ key: 'solana:CollX', name: 'Mad Lads', kind: 'nft' });
  });

  it('keeps the fee but drops movements on failed transactions', () => {
    const r = normalizeSolanaTx(WALLET, { signature: 's', timestamp: 1, fee: 5000, feePayer: WALLET, transactionError: { x: 1 }, nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: BUYER, amount: 1e9 }] }, new Map(), new Map());
    expect(r.movements).toHaveLength(0);
    expect(r.fee).not.toBeNull();
  });
});

describe('nearestDay', () => {
  it('finds the closest available day', () => {
    const days = ['2024-01-01', '2024-01-05', '2024-01-20'];
    expect(nearestDay(days, '2024-01-04')).toBe('2024-01-05');
    expect(nearestDay(days, '2024-01-02')).toBe('2024-01-01');
    expect(nearestDay(days, '2025-01-01')).toBe('2024-01-20');
    expect(nearestDay([], '2024-01-01')).toBeNull();
  });
});

describe('hidden payments (balance-change probe)', () => {
  const { balanceProbeCandidates, inferHiddenNative, normalizeZkSyncEth, EvmActivityFetcher } = jest.requireActual('./evm-activity.fetcher');
  const ETH_ASSET = { key: 'base:native', chain: 'base', kind: 'native', contract: '', name: 'Ether', symbol: 'ETH', price: { kind: 'native', symbol: 'ETH' } };
  const NFT = { key: 'base:0xnft', chain: 'base', kind: 'nft', contract: '0xnft', name: 'Thing', symbol: null, price: null };
  const leg = (txHash: string, direction: 'in' | 'out', asset: object, amount = 1) => ({
    chain: 'base', txHash, timestamp: new Date('2025-01-01T00:00:00Z'), wallet: ME.toLowerCase(), direction, asset, tokenId: '1', amount, counterparty: '',
  });

  it('picks mints with no visible payment and sales with no visible proceeds, skipping shared blocks', () => {
    const movements = [
      leg('0xmint', 'in', NFT),                                  // no money out → probe
      leg('0xpaid', 'in', NFT), leg('0xpaid', 'out', ETH_ASSET, 0.1), // payment visible → skip
      leg('0xsale', 'out', NFT),                                 // no money in → probe
      leg('0xa', 'in', NFT), leg('0xb', 'in', NFT),              // same block → ambiguous → skip
    ];
    const blocks = new Map([['0xmint', '0x10'], ['0xpaid', '0x11'], ['0xsale', '0x12'], ['0xa', '0x13'], ['0xb', '0x13']]);
    expect(balanceProbeCandidates(movements, blocks).map((p: { txHash: string }) => p.txHash).sort()).toEqual(['0xmint', '0xsale']);
  });

  it('recovers the hidden amount net of gas and visible moves, ignoring dust', () => {
    const e = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // ETH → wei (6 dp)
    expect(inferHiddenNative(-e(0.101), e(0.001), 0n)).toBe(-e(0.1)); // paid 0.1 + 0.001 gas
    expect(inferHiddenNative(-e(0.001), e(0.001), 0n)).toBe(0n); // free mint: only gas left
    expect(inferHiddenNative(e(2), 0n, 0n)).toBe(e(2)); // sale proceeds arrived internally
    expect(inferHiddenNative(e(2), 0n, e(0.5))).toBe(e(1.5)); // part already visible
    expect(inferHiddenNative(5n, 0n, 0n)).toBe(0n);
  });

  it('rebuilds a smart-wallet mint: NFT in, payment only visible as a balance drop', async () => {
    const calls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const batch = Array.isArray(body) ? body : [body];
      calls.push(batch[0].method);
      if (batch[0].method === 'alchemy_getAssetTransfers') {
        const incoming = batch[0].params[0].toAddress;
        const transfers = incoming
          ? [{ blockNum: '0x64', uniqueId: 'u1', hash: '0xmint', from: '0x0000000000000000000000000000000000000000', to: ME.toLowerCase(), value: null, asset: 'THING', category: 'erc721', erc721TokenId: '0x1', rawContract: { value: null, address: '0xnft', decimal: null }, metadata: { blockTimestamp: '2025-01-01T00:00:00Z' } }]
          : [];
        return new Response(JSON.stringify({ result: { transfers } }), { status: 200 });
      }
      if (batch[0].method === 'eth_getBalance') {
        // block 0x63 → 1 ETH, block 0x64 → 0.92 ETH: 0.08 ETH left the wallet, no gas (a bundler paid it).
        return new Response(JSON.stringify(batch.map((c: { id: number; params: string[] }) => ({ id: c.id, result: c.params[1] === '0x63' ? '0xde0b6b3a7640000' : '0xcc47f20295c0000' }))), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const r = await new EvmActivityFetcher('key').fetch('base', ME, new Map());
    jest.restoreAllMocks();
    const pay = r.movements.find((m: { inferred?: boolean }) => m.inferred);
    expect(pay).toMatchObject({ txHash: '0xmint', direction: 'out', inferred: true });
    expect(pay.amount).toBeCloseTo(0.08);
    expect(pay.asset.kind).toBe('native');
    expect(calls).toContain('eth_getBalance');
  });

  it('turns Abstract 0x…800a ETH records into native ETH, dropping fee plumbing and duplicates', () => {
    const t = (over: object) => ({ blockNum: '0x1', hash: '0xh', from: ME.toLowerCase(), to: OTHER, value: null, asset: 'ETH', category: 'erc20', rawContract: { value: '0x10', address: '0x000000000000000000000000000000000000800A', decimal: '0x12' }, ...over });
    const out = normalizeZkSyncEth([
      t({ to: '0x0000000000000000000000000000000000008001' }), // fee to bootloader
      t({ category: 'external', rawContract: { value: '0x10', address: null, decimal: null } }), // native copy
      t({}), // duplicate of the native record above
      t({ hash: '0xh2', to: '0xcontract' }), // only visible as 800a → keep as native
    ]);
    expect(out.map((x: { category: string; hash: string }) => `${x.category}:${x.hash}`)).toEqual(['external:0xh', 'internal:0xh2']);
    expect(out[1].rawContract.address).toBeNull();
  });
});

describe('Solana history (Helius)', () => {
  const { SolanaActivityFetcher, normalizeSolanaTx, heliusResumeSignature } = jest.requireActual('./solana-activity.fetcher');
  const { buildCashflowReport } = jest.requireActual('./cashflow-ledger');
  const W = 'AHu9YFzhgCxDscBEEMJwzJG3GnKgWHrB8P214LgGQn8c';
  const SELLER = 'SeLLer1111111111111111111111111111111111111';
  const ESCROW = 'Escrow111111111111111111111111111111111111';
  // Valid base58 (no 0/O/I/l), signature-length.
  const sig = (n: number) => `${'5'.repeat(80)}${String(n).padStart(8, '0').replace(/0/g, 'A')}`;
  const tx = (n: number, extra: object = {}) => ({ signature: sig(n), timestamp: 1_700_000_000 + n, feePayer: 'someoneElse', ...extra });
  afterEach(() => jest.restoreAllMocks());

  function mockHelius(pages: (cursor: string | null) => unknown[]) {
    const cursors: Array<string | null> = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.helius.xyz') {
        const cursor = url.searchParams.get('before-signature');
        cursors.push(cursor);
        return new Response(JSON.stringify(pages(cursor)), { status: 200 });
      }
      return new Response(JSON.stringify({ result: [] }), { status: 200 }); // DAS
    });
    return cursors;
  }

  it('pages with before-signature through the whole history', async () => {
    const all = Array.from({ length: 250 }, (_, i) => tx(250 - i));
    const cursors = mockHelius((cursor) => {
      const start = cursor ? all.findIndex((t) => t.signature === cursor) + 1 : 0;
      return all.slice(start, start + 100);
    });
    const r = await new SolanaActivityFetcher('key').fetch(W, new Map());
    expect(r.transfers).toBe(250);
    expect(r.truncated).toBe(false);
    expect(cursors).toEqual([null, sig(151), sig(51), sig(1)]);
  });

  it('stops instead of re-reading the same page if the cursor is ignored', async () => {
    const page = Array.from({ length: 100 }, (_, i) => tx(100 - i));
    const cursors = mockHelius(() => page);
    const r = await new SolanaActivityFetcher('key').fetch(W, new Map());
    expect(cursors).toHaveLength(2);
    expect(r.transfers).toBe(100); // not 100 × 300 duplicates
    expect(r.notes.join(' ')).toMatch(/stopped early/);
  });

  it('reads compressed NFTs / Core assets from the NFT event when tokenTransfers has none', () => {
    const { movements } = normalizeSolanaTx(
      W,
      tx(1, { type: 'COMPRESSED_NFT_MINT', events: { nft: { type: 'COMPRESSED_NFT_MINT', buyer: W, seller: '', amount: 0, nfts: [{ mint: 'cNFTasset1111' }] } } }),
      new Map(),
      new Map(),
    );
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ direction: 'in', tokenId: 'cNFTasset1111', counterparty: '', amount: 1 });
    expect(movements[0].asset.kind).toBe('nft');
  });

  it('charges a bid filled from escrow once: the bid parks SOL (own move), the fill is the purchase', () => {
    const bid = tx(1, { type: 'NFT_BID', feePayer: W, fee: 5000, nativeTransfers: [{ fromUserAccount: W, toUserAccount: ESCROW, amount: 2e9 }] });
    const fill = tx(2, {
      type: 'NFT_SALE',
      tokenTransfers: [{ fromUserAccount: SELLER, toUserAccount: W, tokenAmount: 1, mint: 'MintA', tokenStandard: 'ProgrammableNonFungible' }],
      events: { nft: { type: 'NFT_SALE', buyer: W, seller: SELLER, amount: 2e9, nfts: [{ mint: 'MintA' }] } },
    });
    const assets = new Map();
    const legs = [bid, fill].flatMap((t) => normalizeSolanaTx(W, t, new Map(), assets).movements);
    expect(legs[0]).toMatchObject({ direction: 'out', counterparty: W }); // escrow deposit → own
    const pay = legs.find((m: { inferred?: boolean }) => m.inferred);
    expect(pay).toMatchObject({ direction: 'out', amount: 2, inferred: true });

    const report = buildCashflowReport({
      movements: legs,
      fees: [],
      wallets: [{ chain: 'solana', address: W }],
      pricer: { usdPerUnit: () => 100 },
      coverage: [],
      notes: [],
      now: new Date(),
    });
    expect(report.totals.outUsd).toBe(200); // spent once, not twice
    expect(report.outByCategory.transfer_out).toBeUndefined();
    expect(report.collections[0]).toMatchObject({ buyCount: 1, spentUsd: 200 });
  });

  it('does not invent a payment when the wallet paid the price itself', () => {
    const { movements } = normalizeSolanaTx(
      W,
      tx(1, {
        type: 'NFT_SALE',
        nativeTransfers: [{ fromUserAccount: W, toUserAccount: SELLER, amount: 1.9e9 }, { fromUserAccount: W, toUserAccount: 'Fees', amount: 0.1e9 }],
        tokenTransfers: [{ fromUserAccount: SELLER, toUserAccount: W, tokenAmount: 1, mint: 'MintA', tokenStandard: 'NonFungible' }],
        events: { nft: { type: 'NFT_SALE', buyer: W, seller: SELLER, amount: 2e9, nfts: [{ mint: 'MintA' }] } },
      }),
      new Map(),
      new Map(),
    );
    expect(movements.some((m: { inferred?: boolean }) => m.inferred)).toBe(false);
    expect(movements.filter((m: { tokenId: string | null }) => m.tokenId === 'MintA')).toHaveLength(1); // not doubled by the event
  });

  it('extracts Helius\' resume signature from its error message', () => {
    const s = sig(7);
    expect(heliusResumeSignature(`Helius address transactions failed (HTTP 404): {"error":"Failed to find events within the search period. To continue search, query the API again with the \`before-signature\` parameter set to ${s}."}`)).toBe(s);
    expect(heliusResumeSignature('HTTP 500')).toBeNull();
  });
});

describe('bulk txs and Solana classification fallbacks', () => {
  const { balanceProbeCandidates, inferHiddenNative } = jest.requireActual('./evm-activity.fetcher');
  const { normalizeSolanaTx } = jest.requireActual('./solana-activity.fetcher');
  const { buildCashflowReport } = jest.requireActual('./cashflow-ledger');
  const ETH_A = { key: 'base:native', chain: 'base', kind: 'native', contract: '', name: 'Ether', symbol: 'ETH', price: { kind: 'native', symbol: 'ETH' } };
  const NFT_A = { key: 'base:0xnft', chain: 'base', kind: 'nft', contract: '0xnft', name: 'Thing', symbol: null, price: null };
  const leg = (direction: 'in' | 'out', asset: object, amount: number, tokenId: string | null = null) => ({
    chain: 'base', txHash: '0xsweep', timestamp: new Date('2025-01-01T00:00:00Z'), wallet: ME.toLowerCase(), direction, asset, tokenId, amount, counterparty: '0xrouter',
  });

  it('on untraced chains, also checks paid asset txs — a sweep refund comes back as money in', () => {
    // Sent 1 ETH to a sweep router for 3 NFTs; 2 filled, 0.3 ETH refunded inside the call.
    const legs = [leg('out', ETH_A, 1), leg('in', NFT_A, 1, '1'), leg('in', NFT_A, 1, '2')];
    const blocks = new Map([['0xsweep', '0x10']]);
    expect(balanceProbeCandidates(legs, blocks, false)).toHaveLength(0); // traced chains: payment visible → skip
    const [probe] = balanceProbeCandidates(legs, blocks, true);
    expect(probe.visibleNativeWei).toBe(-(10n ** 18n));
    const e = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
    // Balance fell 0.7 ETH + 0.002 gas.
    expect(inferHiddenNative(-e(0.702), e(0.002), probe.visibleNativeWei)).toBe(e(0.3));

    const report = buildCashflowReport({
      movements: [...legs, { ...leg('in', ETH_A, 0.3), counterparty: 'contract', inferred: true }],
      fees: [],
      wallets: [{ chain: 'base', address: ME }],
      pricer: { usdPerUnit: () => 3000 },
      coverage: [],
      notes: [],
      now: new Date(),
    });
    expect(report.collections[0]).toMatchObject({ buyCount: 2, qtyBought: 2 });
    expect(report.collections[0].spentUsd).toBeCloseTo(2100); // 0.7 ETH, not 1
    expect(report.totals.inUsd).toBe(0); // the refund isn't income
  });

  const W = 'AHu9YFzhgCxDscBEEMJwzJG3GnKgWHrB8P214LgGQn8c';
  const t = (extra: object) => ({ signature: 'sig', timestamp: 1_700_000_000, ...extra });

  it('treats a lone indivisible token as an NFT when neither DAS nor the transfer says', () => {
    const { movements } = normalizeSolanaTx(
      W,
      t({ tokenTransfers: [{ fromUserAccount: 'x', toUserAccount: W, tokenAmount: 1, decimals: 0, mint: 'MintNoMeta' }] }),
      new Map(),
      new Map(),
    );
    expect(movements[0].asset.kind).toBe('nft');
    const fungible = normalizeSolanaTx(
      W,
      t({ tokenTransfers: [{ fromUserAccount: 'x', toUserAccount: W, tokenAmount: 1, decimals: 0, mint: 'MintF', tokenStandard: 'Fungible' }] }),
      new Map(),
      new Map(),
    ).movements;
    expect(fungible[0].asset.kind).toBe('fungible');
  });

  it("keeps an escrow-listed NFT as the user's, and books the sale when the listing fills", () => {
    const assets = new Map();
    const listing = t({ signature: 'list', type: 'NFT_LISTING', tokenTransfers: [{ fromUserAccount: W, toUserAccount: 'MEescrow', tokenAmount: 1, mint: 'MintA', tokenStandard: 'NonFungible' }] });
    const buy = t({ signature: 'buy', timestamp: 1_600_000_000, type: 'NFT_SALE', nativeTransfers: [{ fromUserAccount: W, toUserAccount: 'Seller', amount: 1e9 }], tokenTransfers: [{ fromUserAccount: 'Seller', toUserAccount: W, tokenAmount: 1, mint: 'MintA', tokenStandard: 'NonFungible' }], events: { nft: { type: 'NFT_SALE', buyer: W, seller: 'Seller', amount: 1e9, nfts: [{ mint: 'MintA' }] } } });
    // Filled from escrow: the NFT leaves the escrow (not the wallet); the wallet gets paid.
    const fill = t({ signature: 'fill', timestamp: 1_800_000_000, type: 'NFT_SALE', nativeTransfers: [{ fromUserAccount: 'Buyer', toUserAccount: W, amount: 3e9 }], tokenTransfers: [{ fromUserAccount: 'MEescrow', toUserAccount: 'Buyer', tokenAmount: 1, mint: 'MintA' }], events: { nft: { type: 'NFT_SALE', buyer: 'Buyer', seller: W, amount: 3e9, nfts: [{ mint: 'MintA' }] } } });
    const movements = [buy, listing, fill].flatMap((x) => normalizeSolanaTx(W, x, new Map(), assets).movements);
    const report = buildCashflowReport({
      movements,
      fees: [],
      wallets: [{ chain: 'solana', address: W }],
      pricer: { usdPerUnit: () => 100 },
      coverage: [],
      notes: [],
      now: new Date(),
    });
    const c = report.collections[0];
    expect(c).toMatchObject({ buyCount: 1, sellCount: 1, qtySoldWithoutBasis: 0 });
    expect(c.realizedPnlUsd).toBeCloseTo(200); // bought 1 SOL, sold 3 SOL @ $100
    expect(c.realizedPnlNative).toBeCloseTo(2);
  });
});
