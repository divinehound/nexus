import type { LedgerAsset, LedgerMovement } from './cashflow-ledger';
import { EvmActivityFetcher, type AlchemyTransfer } from './evm-activity.fetcher';
import { failedScan, fromSaved, replaceTxs, toSaved } from './scan-store';
import { SolanaActivityFetcher } from './solana-activity.fetcher';
import { remoteScanActive, targetSignature } from './cashflow.service';

const ME = '0x1111111111111111111111111111111111111111';
const ETH: LedgerAsset = { key: 'base:native', chain: 'base', kind: 'native', contract: '', name: 'Ether', symbol: 'ETH', price: { kind: 'native', symbol: 'ETH' } };
const NFT: LedgerAsset = { key: 'base:0xnft', chain: 'base', kind: 'nft', contract: '0xnft', name: 'Cool Cats', symbol: null, price: null };

const mv = (tx: string, direction: 'in' | 'out', asset: LedgerAsset, amount: number, extra: Partial<LedgerMovement> = {}): LedgerMovement => ({
  chain: 'base',
  txHash: tx,
  timestamp: new Date('2025-03-01T12:00:00Z'),
  wallet: ME,
  direction,
  asset,
  tokenId: asset.kind === 'nft' ? '7' : null,
  amount,
  counterparty: '0xmarket',
  ...extra,
});

describe('saved scans', () => {
  const result = {
    movements: [mv('0xa', 'out', ETH, 0.5), mv('0xa', 'in', NFT, 1), mv('0xb', 'in', ETH, 0.2, { inferred: true })],
    fees: [{ chain: 'base', txHash: '0xa', wallet: ME, timestamp: new Date('2025-03-01T12:00:00Z'), feeNative: 0.0001, symbol: 'ETH' }],
    transfers: 3,
    truncated: false,
    notes: ['a note'],
    stats: { transfers: 3 },
  };

  it('round-trips a scan through JSON, sharing one asset object per key', () => {
    const saved = JSON.parse(JSON.stringify(toSaved(result)));
    const assets = new Map<string, LedgerAsset>();
    const r = fromSaved(saved, 'base', ME, new Date('2025-03-02T00:00:00Z'), assets);
    expect(r.movements).toEqual(result.movements);
    expect(r.fees).toEqual(result.fees);
    expect(r.movements[0].asset).toBe(r.movements[2].asset);
    expect(r.coverage).toMatchObject({ chain: 'base', address: ME, transfers: 3, error: null, scannedAt: '2025-03-02T00:00:00.000Z', stats: { transfers: 3 } });
    expect(r.notes).toEqual(['a note']);
  });

  it('lets a newer scan update an asset name loaded from an older one', () => {
    const assets = new Map<string, LedgerAsset>();
    const older = toSaved({ ...result, movements: [mv('0xa', 'in', { ...NFT, name: '0xnft…' }, 1)] });
    const a = fromSaved(older, 'base', ME, new Date(), assets);
    fromSaved(toSaved(result), 'base', ME, new Date(), assets);
    expect(a.movements[0].asset.name).toBe('Cool Cats');
  });

  it('replaces only the re-imported transactions', () => {
    const saved = toSaved(result);
    const fresh = { ...result, movements: [mv('0xa', 'out', ETH, 0.3), mv('0xa', 'in', NFT, 1)], fees: [], notes: [] };
    const next = replaceTxs(saved, new Set(['0xa']), fresh);
    const r = fromSaved(next, 'base', ME, new Date(), new Map());
    expect(r.movements.filter((m) => m.txHash === '0xa').map((m) => m.amount).sort()).toEqual([0.3, 1]);
    expect(r.movements.filter((m) => m.txHash === '0xb')).toHaveLength(1);
    expect(r.fees).toEqual([]);
    expect(next.transfers).toBe(3);
  });

  it('shows a failed scan as an error, and a disabled network as not an error', () => {
    expect(fromSaved(failedScan('boom'), 'base', ME, new Date(), new Map()).coverage.error).toBe('boom');
    const off = fromSaved(failedScan('HTTP 403', true), 'zora', ME, new Date(), new Map()).coverage;
    expect(off).toMatchObject({ error: null, disabled: true });
  });

  it('signs targets independent of order', () => {
    expect(targetSignature([{ chain: 'base', address: 'a' }, { chain: 'ethereum', address: 'a' }])).toBe(
      targetSignature([{ chain: 'ethereum', address: 'a' }, { chain: 'base', address: 'a' }]),
    );
  });

  it('treats a scan whose instance stopped checking in as abandoned', () => {
    const now = Date.parse('2025-03-01T12:00:00Z');
    const state = { userId: 'u', status: 'scanning', progress: null, error: null, startedAt: new Date(now - 600_000), dataVersion: new Date(0) };
    expect(remoteScanActive({ ...state, heartbeatAt: new Date(now - 30_000) }, now)).toBe(true);
    expect(remoteScanActive({ ...state, heartbeatAt: new Date(now - 300_000) }, now)).toBe(false);
    expect(remoteScanActive({ ...state, status: 'idle', heartbeatAt: new Date(now) }, now)).toBe(false);
  });
});

describe('re-reading flagged transactions', () => {
  afterEach(() => jest.restoreAllMocks());

  it('EVM: reads the tx block for the wallet and keeps only the flagged tx', async () => {
    const transfer = (hash: string, extra: Partial<AlchemyTransfer>): AlchemyTransfer => ({
      blockNum: '0x64',
      hash,
      from: ME,
      to: '0xmarket',
      value: 0.5,
      asset: 'ETH',
      category: 'external',
      rawContract: { value: '0x6f05b59d3b20000', address: null, decimal: '0x12' },
      metadata: { blockTimestamp: '2025-03-01T12:00:00Z' },
      ...extra,
    });
    const calls: Array<{ method: string; params: unknown[] }> = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const list = Array.isArray(body) ? body : [body];
      calls.push(...list);
      const reply = (result: unknown) => new Response(JSON.stringify(result), { status: 200 });
      if (list[0].method === 'eth_getTransactionByHash') return reply(list.map((c) => ({ id: c.id, result: { blockNumber: '0x64' } })));
      if (list[0].method === 'alchemy_getAssetTransfers') {
        const p = list[0].params[0] as Record<string, string>;
        // Two of the wallet's txs in the block; only 0xflagged was asked for.
        return reply({ result: { transfers: p.fromAddress ? [transfer('0xflagged', {}), transfer('0xother', {})] : [] } });
      }
      if (list[0].method === 'eth_getTransactionReceipt')
        return reply(list.map((c) => ({ id: c.id, result: { from: ME, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' } })));
      return reply(list.map((c) => ({ id: c.id, result: '0x0' })));
    });
    const r = await new EvmActivityFetcher('key').fetchTxs('base', ME, ['0xFLAGGED'], new Map());
    const assetCalls = calls.filter((c) => c.method === 'alchemy_getAssetTransfers');
    expect(assetCalls).toHaveLength(2);
    expect(assetCalls.every((c) => (c.params[0] as Record<string, string>).fromBlock === '0x64' && (c.params[0] as Record<string, string>).toBlock === '0x64')).toBe(true);
    expect(r.movements.map((m) => m.txHash)).toEqual(['0xflagged']);
    expect(r.fees.map((f) => f.txHash)).toEqual(['0xflagged']);
  });

  it('Solana: parses just the given signatures', async () => {
    const SOLME = 'SoLMe1111111111111111111111111111111111111';
    const urls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      urls.push(String(url));
      if (String(url).includes('/v0/transactions')) {
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({ transactions: ['sig1'] });
        return new Response(
          JSON.stringify([
            {
              signature: 'sig1',
              timestamp: 1_740_000_000,
              fee: 5000,
              feePayer: SOLME,
              nativeTransfers: [{ fromUserAccount: SOLME, toUserAccount: 'Seller', amount: 2_000_000_000 }],
              tokenTransfers: [{ fromUserAccount: 'Seller', toUserAccount: SOLME, tokenAmount: 1, mint: 'Mint1', tokenStandard: 'NonFungible' }],
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    });
    const r = await new SolanaActivityFetcher('key').fetchTxs(SOLME, ['sig1'], new Map());
    expect(urls.filter((u) => u.includes('/addresses/'))).toEqual([]);
    expect(r.movements.map((m) => [m.direction, m.asset.kind, m.amount])).toEqual([
      ['out', 'native', 2],
      ['in', 'nft', 1],
    ]);
    expect(r.fees).toHaveLength(1);
  });
});
