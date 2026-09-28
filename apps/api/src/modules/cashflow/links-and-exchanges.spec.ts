import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { relayRequestToLink } from './relay-links.fetcher';
import { sweepTarget } from './cashflow.service';
import { EVM_EXCHANGE_WALLETS } from './exchange-wallets';
import { AddressTagDto, TxLinkDto } from './cashflow.controller';

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
});

describe('link delete conditions stay scoped to the user', () => {
  // Imported lazily so the pure tests above don't need the DB schema.
  const { PgDialect } = jest.requireActual('drizzle-orm/pg-core');
  const { samePairCondition, sharesTxLinkCondition, normalizePair } = jest.requireActual('./cashflow.service');
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

  it('shares-a-tx delete', () => {
    const q = dialect.sqlToQuery(sharesTxLinkCondition('user-1', pair));
    assertScoped(q.sql);
    expect(q.sql).toContain('"kind" = $2');
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
  const { CashflowService, sameWallet } = jest.requireActual('./cashflow.service');
  const A = '0xAAAA000000000000000000000000000000000001';
  const B = '0xbbbb000000000000000000000000000000000002';
  const ETH = { key: 'ethereum:native', chain: 'ethereum', kind: 'native', contract: '', name: 'Ether', symbol: 'ETH', price: { kind: 'native', symbol: 'ETH' } };
  const mv = (tx: string, wallet: string, direction: 'in' | 'out', counterparty: string, amount: number) => ({
    chain: 'ethereum', txHash: tx, timestamp: new Date('2025-01-01T00:00:00Z'), wallet: wallet.toLowerCase(), direction, asset: ETH, tokenId: null, amount, counterparty,
  });

  function service() {
    const linked = [{ chain: 'ethereum', address: A }, { chain: 'ethereum', address: B }];
    const db = {
      query: { wallets: { findMany: async () => linked } },
      select: () => ({ from: () => ({ where: async () => [] }) }),
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
    };
    const signature = linked.map((w) => `${w.chain}:${w.address}`).sort().join('|');
    (svc as never as { entries: Map<string, unknown> }).entries.set('u', {
      status: 'ready', startedAt: new Date(), progress: '', report: null, error: null, walletsSignature: signature, scan,
    });
    return svc;
  }

  it('reports one wallet at a time; moves to your other wallets are still not spending', async () => {
    const svc = service();
    const all = await svc.rebuild('u'); // builds the cached all-wallets report from the scan
    expect(all.report.walletFilter).toBeNull();
    expect(all.report.outByCategory.transfer_out).toBe(3000);

    const onlyA = await svc.getReport('u', false, A.toLowerCase());
    expect(onlyA.report.walletFilter).toBe(A.toLowerCase());
    expect(onlyA.report.outByCategory.transfer_out).toBe(1000);
    expect(onlyA.report.ownWalletTransfers.count).toBe(1);
    expect(onlyA.report.wallets).toHaveLength(2); // dropdown still lists every wallet
  });

  it('rejects a wallet that is not linked', async () => {
    await expect(service().getReport('u', false, '0xdead000000000000000000000000000000000000')).rejects.toThrow('not linked');
  });

  it('compares EVM addresses case-insensitively, Solana exactly', () => {
    expect(sameWallet(A, A.toLowerCase())).toBe(true);
    expect(sameWallet('SoLabc', 'solabc')).toBe(false);
  });
});
