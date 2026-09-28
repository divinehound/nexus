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
