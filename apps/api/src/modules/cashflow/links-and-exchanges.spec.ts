import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { relayRequestToLink } from './relay-links.fetcher';
import { sweepTarget } from './cashflow.service';
import { EVM_EXCHANGE_WALLETS } from './exchange-wallets';
import { AddressTagDto, AssetPrefDto, WriteOffDto, ContactLabelBatchDto, ContactLabelRemoveDto, TxLinkDto } from './cashflow.controller';

const coinbase = [...EVM_EXCHANGE_WALLETS].filter(([, name]) => name === 'Coinbase').map(([a]) => a);
const binance = [...EVM_EXCHANGE_WALLETS].filter(([, name]) => name === 'Binance').map(([a]) => a);

describe('relayRequestToLink', () => {
  it('links the origin deposit to the destination fill (Relay v3 shape)', () => {
    expect(
      relayRequestToLink({
        status: 'success',
        data: {
          inTxs: [{ txHash: '0xabc', chainId: 1 }],
          outTxs: [{ txHash: '5SoLsig', chainId: 792703809 }],
        },
      }),
    ).toEqual({ fromChain: 'ethereum', fromTxHash: '0xabc', toChain: 'solana', toTxHash: '5SoLsig', source: 'relay' });
  });

  it('reads the public v2 shape (hash instead of txHash), e.g. a bridge out of Robinhood Chain', () => {
    expect(
      relayRequestToLink({
        status: 'success',
        data: { inTxs: [{ hash: '0xrh', chainId: 4663 }], outTxs: [{ hash: '0xbase', chainId: 8453 }] },
      }),
    ).toEqual({ fromChain: 'robinhood', fromTxHash: '0xrh', toChain: 'base', toTxHash: '0xbase', source: 'relay' });
  });

  it('skips unfinished requests, unknown chains and same-chain swaps', () => {
    const data = { inTxs: [{ txHash: '0xa', chainId: 1 }], outTxs: [{ txHash: '0xb', chainId: 8453 }] };
    expect(relayRequestToLink({ status: 'refunded', data })).toBeNull();
    expect(relayRequestToLink({ status: 'success', data: { ...data, outTxs: [{ txHash: '0xb', chainId: 999999 }] } })).toBeNull();
    expect(relayRequestToLink({ status: 'success', data: { ...data, outTxs: [{ txHash: '0xb', chainId: 1 }] } })).toBeNull();
    expect(relayRequestToLink({ status: 'success', data: { inTxs: [], outTxs: [] } })).toBeNull();
  });
});

describe('sweepTarget', () => {
  it('recognises a deposit address that forwards to one exchange', () => {
    expect(sweepTarget([coinbase[0], coinbase[1], coinbase[0].toUpperCase().replace('0X', '0x')])).toBe('Coinbase');
  });

  it('ignores a normal wallet that only occasionally sends to an exchange', () => {
    expect(sweepTarget([coinbase[0], '0xfriend1', '0xfriend2', '0xdex'])).toBeNull();
  });

  it('picks the dominant exchange and needs at least half the sends', () => {
    expect(sweepTarget([binance[0], binance[1], coinbase[0], '0xother'])).toBe('Binance');
    expect(sweepTarget([])).toBeNull();
  });

  it('ships a non-trivial, lowercased exchange list', () => {
    expect(EVM_EXCHANGE_WALLETS.size).toBeGreaterThan(100);
    for (const a of EVM_EXCHANGE_WALLETS.keys()) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
    expect(EVM_EXCHANGE_WALLETS.get('0x71660c4005ba85c37ccec55d0c4493e66fe775d3')).toBe('Coinbase');
  });
});

describe('request validation', () => {
  const errors = (cls: new () => object, body: object) => validateSync(plainToInstance(cls, body)).map((e) => e.property);

  it('accepts EVM and Solana hashes on supported chains', () => {
    expect(errors(TxLinkDto, { kind: 'link', fromChain: 'ethereum', fromTxHash: '0x' + 'a'.repeat(64), toChain: 'solana', toTxHash: '5'.repeat(87) })).toEqual([]);
  });

  it('rejects unknown chains, junk hashes and bad kinds', () => {
    expect(errors(TxLinkDto, { kind: 'merge', fromChain: 'bitcoin', fromTxHash: "0x'; drop", toChain: 'base', toTxHash: '0x' + 'b'.repeat(64) })).toEqual(
      ['kind', 'fromChain', 'fromTxHash'],
    );
    expect(errors(AddressTagDto, { chain: 'base', address: '0x123', exchange: '' })).toEqual(['address', 'exchange']);
  });

  it('checks write-offs', () => {
    expect(errors(WriteOffDto, { assetKey: 'solana:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', tokenId: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', lost: true })).toEqual([]);
    expect(errors(WriteOffDto, { assetKey: 'ethereum:0xe1030883a69968a08263a7919656bfd6176a1f02', lost: false })).toEqual([]);
    expect(errors(WriteOffDto, { assetKey: 'ethereum:0xe1030883a69968a08263a7919656bfd6176a1f02', tokenId: '1; drop', lost: 'yes' })).toEqual(['tokenId', 'lost']);
  });

  it('accepts only real asset keys for hiding a token', () => {
    expect(errors(AssetPrefDto, { assetKey: 'polygon:0xe1030883a69968a08263a7919656bfd6176a1f02', pref: 'hidden' })).toEqual([]);
    expect(errors(AssetPrefDto, { assetKey: 'solana:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', pref: null })).toEqual([]);
    expect(errors(AssetPrefDto, { assetKey: 'bitcoin:0xe1030883a69968a08263a7919656bfd6176a1f02', pref: 'hidden' })).toEqual(['assetKey']);
    expect(errors(AssetPrefDto, { assetKey: "polygon:0x'; drop table", pref: 'spam' })).toEqual(['assetKey', 'pref']);
  });

  it('checks every target when naming many transfers at once', () => {
    const tx = (ref: string, chain = 'ethereum') => ({ kind: 'tx', chain, ref });
    expect(errors(ContactLabelBatchDto, { targets: [tx('0x' + 'a'.repeat(64)), tx('5'.repeat(87), 'solana')], label: 'Bob' })).toEqual([]);
    expect(errors(ContactLabelBatchDto, { targets: [tx('0x' + 'a'.repeat(64)), tx("0x'; drop")], label: 'Bob' })).toEqual(['targets']);
    expect(errors(ContactLabelBatchDto, { targets: [], label: '' })).toEqual(['targets', 'label']);
    expect(errors(ContactLabelRemoveDto, { ids: ['not-a-uuid'] })).toEqual(['ids']);
  });
});

describe('link delete conditions stay scoped to the user', () => {
  // Imported lazily so the pure tests above don't need the DB schema.
  const { PgDialect } = jest.requireActual('drizzle-orm/pg-core');
  const { samePairCondition, normalizePair } = jest.requireActual('./cashflow.service');
  const dialect = new PgDialect();
  const pair = { fromChain: 'ethereum', fromTxHash: '0xabc', toChain: 'solana', toTxHash: 'SoLsig' };

  /** The user filter must AND with one parenthesised group holding every OR. */
  const assertScoped = (sqlText: string) => {
    expect(sqlText.startsWith('("cashflow_tx_links"."user_id" = $1 and ')).toBe(true);
    // Every " or " must sit inside a bracket opened after the user filter.
    const afterUser = sqlText.slice('("cashflow_tx_links"."user_id" = $1 and '.length).toLowerCase();
    let depth = 0;
    for (let i = 0; i < afterUser.length; i++) {
      if (afterUser[i] === '(') depth++;
      if (afterUser[i] === ')') depth--;
      if (afterUser.startsWith(' or ', i)) expect(depth).toBeGreaterThan(0);
    }
  };

  it('would catch an unparenthesised raw OR (the original bug)', () => {
    const { and, eq, sql } = jest.requireActual('drizzle-orm');
    const { cashflowTxLinks: t } = jest.requireActual('@nexus/database');
    const buggy = and(eq(t.userId, 'u'), sql`(${t.fromChain} = ${'a'}) OR (${t.toChain} = ${'b'})`);
    expect(() => assertScoped(dialect.sqlToQuery(buggy).sql)).toThrow();
  });

  it('same-pair delete (both directions)', () => {
    const q = dialect.sqlToQuery(samePairCondition('user-1', pair));
    assertScoped(q.sql);
    expect(q.params[0]).toBe('user-1');
  });

  it('lowercases EVM hashes but not Solana signatures', () => {
    expect(normalizePair({ fromChain: 'base', fromTxHash: '0xABC', toChain: 'solana', toTxHash: 'SoLSig' })).toEqual({
      fromChain: 'base',
      fromTxHash: '0xabc',
      toChain: 'solana',
      toTxHash: 'SoLSig',
    });
  });
});

describe('EVM history paging', () => {
  const { EvmActivityFetcher } = jest.requireActual('./evm-activity.fetcher');
  afterEach(() => jest.restoreAllMocks());

  it('pages newest-first so a capped wallet keeps its recent history', async () => {
    const bodies: Array<{ method: string; params: Array<Record<string, unknown>> }> = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      bodies.push(body);
      // Every page says there's more → the fetcher must stop at its cap and report truncation.
      return new Response(JSON.stringify({ result: { transfers: [], pageKey: 'next' } }), { status: 200 });
    });
    const r = await new EvmActivityFetcher('key').fetch('base', '0x1111111111111111111111111111111111111111', new Map());
    const transferCalls = bodies.filter((b) => b.method === 'alchemy_getAssetTransfers');
    expect(transferCalls.length).toBeGreaterThan(2);
    expect(transferCalls.every((b) => b.params[0].order === 'desc')).toBe(true);
    expect(r.truncated).toBe(true);
  });
});

describe('wallet filter', () => {
  const { CashflowService, sameWallet, targetSignature } = jest.requireActual('./cashflow.service');
  const { EVM_CHAINS } = jest.requireActual('./evm-activity.fetcher');
  const A = '0xAAAA000000000000000000000000000000000001';
  const B = '0xbbbb000000000000000000000000000000000002';
  const ETH = { key: 'ethereum:native', chain: 'ethereum', kind: 'native', contract: '', name: 'Ether', symbol: 'ETH', price: { kind: 'native', symbol: 'ETH' } };
  const mv = (tx: string, wallet: string, direction: 'in' | 'out', counterparty: string, amount: number) => ({
    chain: 'ethereum', txHash: tx, timestamp: new Date('2025-01-01T00:00:00Z'), wallet: wallet.toLowerCase(), direction, asset: ETH, tokenId: null, amount, counterparty,
  });

  function service(watchB = false, rows = new Map<unknown, unknown[]>()) {
    const linked = [{ chain: 'ethereum', address: A }, { chain: 'ethereum', address: B }];
    const verified = watchB ? linked.slice(0, 1) : linked;
    const watched = watchB ? [{ family: 'evm', address: B.toLowerCase() }] : [];
    const db = {
      query: { wallets: { findMany: async () => verified }, watchedWallets: { findMany: async () => watched } },
      select: () => ({ from: (table: unknown) => ({ where: async () => rows.get(table) ?? [] }) }),
    };
    const svc = new CashflowService(db as never, { get: () => '' } as never, {} as never);
    const scan = {
      wallets: linked,
      movements: [
        mv('0x1', A, 'out', '0xfriend', 1), // A sends 1 ETH to a friend
        mv('0x2', B, 'out', '0xfriend', 2), // B sends 2 ETH to a friend
        mv('0x3', A, 'out', B.toLowerCase(), 5), // A → B (own)
        mv('0x3', B, 'in', A.toLowerCase(), 5),
      ],
      fees: [],
      pricer: { usdPerUnit: () => 1000 },
      coverage: [],
      notes: [],
      relayLinks: [],
      detectedExchanges: new Map(),
      walletChains: [],
    };
    const signature = targetSignature(
      linked.flatMap((w) => EVM_CHAINS.map((chain: string) => ({ chain, address: w.address.toLowerCase() }))),
    );
    (svc as never as { entries: Map<string, unknown> }).entries.set('u', {
      status: 'ready', startedAt: new Date(), progress: '', report: null, error: null, signature, dataVersion: 0, scan,
    });
    return svc;
  }

  it('reports one wallet at a time; moves to your other wallets are still not spending', async () => {
    const svc = service();
    const all = await svc.rebuild('u'); // builds the cached all-wallets report from the scan
    expect(all.report.walletFilter).toBeNull();
    expect(all.report.outByCategory.transfer_out).toBe(3000);

    const onlyA = await svc.getReport('u', false, { wallet: A.toLowerCase() });
    expect(onlyA.report.walletFilter).toBe(A.toLowerCase());
    expect(onlyA.report.outByCategory.transfer_out).toBe(1000);
    expect(onlyA.report.ownWalletTransfers.count).toBe(1);
    expect(onlyA.report.wallets).toHaveLength(2); // dropdown still lists every wallet
  });

  it('narrows to one chain without rescanning', async () => {
    const svc = service();
    await svc.rebuild('u');
    const base = await svc.getReport('u', false, { chain: 'base' });
    expect(base.report.chainFilter).toBe('base');
    expect(base.report.activity).toHaveLength(0);
    await expect(svc.getReport('u', false, { chain: 'dogechain' })).rejects.toThrow('Unknown chain');
  });

  it('counts a watch-only wallet as your own and lets you filter to it', async () => {
    const svc = service(true);
    await svc.rebuild('u');
    const onlyB = await svc.getReport('u', false, { wallet: B });
    expect(onlyB.report.outByCategory.transfer_out).toBe(2000);
    expect(onlyB.report.ownWalletTransfers.count).toBe(1); // A → B is still a move between your wallets
  });

  it('applies your names for people and your notes on transactions', async () => {
    const { cashflowContactLabels, cashflowTxNotes } = jest.requireActual('@nexus/database');
    const svc = service(
      false,
      new Map<unknown, unknown[]>([
        [
          cashflowContactLabels,
          [
            { id: 'l1', kind: 'address', scope: 'evm', ref: '0xfriend', label: 'Bob' },
            { id: 'l2', kind: 'tx', scope: 'ethereum', ref: '0x2', label: 'Alice' },
          ],
        ],
        [cashflowTxNotes, [{ id: 'n1', chain: 'ethereum', txHash: '0x1', note: 'rent', updatedAt: new Date('2025-02-01T00:00:00Z') }]],
      ]),
    );
    const { report } = await svc.rebuild('u');
    expect(report.contacts.map((c: { name: string; sentUsd: number }) => [c.name, c.sentUsd])).toEqual([
      ['Alice', 2000],
      ['Bob', 1000],
    ]);
    expect(report.contactLabels).toHaveLength(2);
    expect(report.txNotes).toEqual([
      { id: 'n1', chain: 'ethereum', txHash: '0x1', note: 'rent', updatedAt: '2025-02-01T00:00:00.000Z' },
    ]);
  });

  it('rejects a wallet that is not linked', async () => {
    await expect(service().getReport('u', false, { wallet: '0xdead000000000000000000000000000000000000' })).rejects.toThrow('not linked');
  });

  it('compares EVM addresses case-insensitively, Solana exactly', () => {
    expect(sameWallet(A, A.toLowerCase())).toBe(true);
    expect(sameWallet('SoLabc', 'solabc')).toBe(false);
  });
});

describe('Robinhood Chain', () => {
  const { EVM_CHAINS, evmAssetFor } = jest.requireActual('./evm-activity.fetcher');
  const { RELAY_CHAIN_IDS } = jest.requireActual('./relay-links.fetcher');

  it('is scanned as an ETH-gas EVM chain and maps from its chain id', () => {
    expect(EVM_CHAINS).toContain('robinhood');
    expect(evmAssetFor('robinhood', { category: 'external' }, new Map()).price).toEqual({ kind: 'native', symbol: 'ETH' });
    expect(RELAY_CHAIN_IDS[4663]).toBe('robinhood');
  });

  it('prices WETH and USDG, so an NFT sold for USDG is a sale, not a swap', () => {
    const { buildCashflowReport } = jest.requireActual('./cashflow-ledger');
    const { fromSaved } = jest.requireActual('./scan-store');
    const me = '0xa000000000000000000000000000000000000001';
    const usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
    const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
    expect(evmAssetFor('robinhood', { category: 'erc20', rawContract: { address: weth } }, new Map()).price).toEqual({ kind: 'native', symbol: 'ETH' });
    // A scan saved before USDG was priced still gets its price on load.
    const saved = {
      assets: [
        { key: `robinhood:${usdg}`, chain: 'robinhood', kind: 'fungible', contract: usdg, name: 'USDG', symbol: 'USDG', price: null },
        { key: 'robinhood:0xnft', chain: 'robinhood', kind: 'nft', contract: '0xnft', name: 'Button Presser', symbol: null, price: null },
      ],
      movements: [
        { h: '0xsale', t: Date.parse('2026-08-28T14:24:25Z'), d: 'out', a: 'robinhood:0xnft', i: '3821', n: 1, p: '0xbuyer' },
        { h: '0xsale', t: Date.parse('2026-08-28T14:24:25Z'), d: 'in', a: `robinhood:${usdg}`, n: 90, p: '0xrelayrouter' },
      ],
      fees: [],
      transfers: 2,
      truncated: false,
      notes: [],
    };
    const loaded = fromSaved(saved, 'robinhood', me, new Date(), new Map());
    const r = buildCashflowReport({
      movements: loaded.movements,
      fees: [],
      wallets: [{ chain: 'robinhood', address: me }],
      pricer: { usdPerUnit: (ref: { kind: string }) => (ref.kind === 'usd' ? 1 : 2700) },
      coverage: [],
      notes: [],
      now: new Date('2026-09-01T00:00:00Z'),
    });
    expect(r.activity[0].type).toBe('nft_sale');
    expect(r.inByCategory.nft_sale).toBeCloseTo(90);
  });
});

describe('Arc', () => {
  const { EVM_CHAINS, evmAssetFor, normalizeArcUsdc, normalizeEvmTransfer } = jest.requireActual('./evm-activity.fetcher');
  const { RELAY_CHAIN_IDS } = jest.requireActual('./relay-links.fetcher');
  const { nativeSymbolFor } = jest.requireActual('./base-assets');
  const me = '0x00000000000000000000000000000000000000aa';
  const shop = '0x00000000000000000000000000000000000000bb';
  const usdc = '0x3600000000000000000000000000000000000000';
  const emitter = '0xfffffffffffffffffffffffffffffffffffffffe';
  const ten18 = '0x8ac7230489e80000'; // 10 USDC at 18 decimals
  const ten6 = '0x989680'; // 10 USDC at 6 decimals

  it('is scanned as a USDC-gas EVM chain priced at $1 and maps from its chain id', () => {
    expect(EVM_CHAINS).toContain('arc');
    expect(evmAssetFor('arc', { category: 'external' }, new Map()).price).toEqual({ kind: 'usd' });
    expect(nativeSymbolFor('arc')).toBe('USDC');
    expect(RELAY_CHAIN_IDS[5042]).toBe('arc');
  });

  it('counts a USDC move once whether it shows as native value, the ERC-20 interface or the system emitter', () => {
    const t = (hash: string, category: string, contract: string | null, value: string) => ({
      hash, category, from: me, to: shop, blockNum: '0x1',
      rawContract: { address: contract, value, decimal: contract === usdc ? '0x6' : '0x12' },
    });
    const out = normalizeArcUsdc([
      // Native send: value + emitter log.
      t('0x1', 'external', null, ten18),
      t('0x1', 'erc20', emitter, ten18),
      // ERC-20 transfer(): interface log + emitter log.
      t('0x2', 'erc20', usdc, ten6),
      t('0x2', 'erc20', emitter, ten18),
      // Emitter records not indexed: the ERC-20 record alone still counts.
      t('0x3', 'erc20', usdc, ten6),
      // A contract paid out USDC: only the emitter saw it.
      { ...t('0x4', 'erc20', emitter, ten18), from: shop, to: me },
    ]);
    expect(out.map((x: { hash: string }) => x.hash)).toEqual(['0x1', '0x2', '0x3', '0x4']);
    expect(out.every((x: { category: string }) => x.category !== 'erc20')).toBe(true);
    const moves = out.flatMap((x: object) => normalizeEvmTransfer('arc', me, x, new Date(), new Map()));
    expect(moves.map((m: { amount: number; direction: string }) => [m.amount, m.direction])).toEqual([
      [10, 'out'], [10, 'out'], [10, 'out'], [10, 'in'],
    ]);
  });
});
