import { budgetFor, type ChainEnv, ensNames, funderOf, headBlock, RateLimited, readTransfers, txDetails, units } from './chain';

const C = '0x00000000000000000000000000000000000000aa';
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';

/** A ChainEnv whose fetch answers each request in turn from `answers` and records the bodies. */
function stub(answers: { status?: number; body?: unknown }[]) {
  const bodies: any[] = [];
  const env: ChainEnv = {
    rpcUrl: 'https://eth-mainnet.example/v2/k',
    chainId: 1,
    mainnet: true,
    fetch: (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const a = answers.shift() ?? { status: 500 };
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
    }) as unknown as typeof fetch,
  };
  return { env, bodies };
}

const transfer = (block: number, log: number, extra: Record<string, unknown>) => ({
  blockNum: `0x${block.toString(16)}`,
  uniqueId: `0xHASH${block}:log:${log}`,
  hash: `0xHASH${block}`,
  from: A.toUpperCase().replace('0X', '0x'),
  to: B,
  category: 'erc721',
  rawContract: {},
  metadata: { blockTimestamp: '2026-01-01T00:00:00.000Z' },
  ...extra,
});

describe('holder analysis chain reader', () => {
  it('reads ERC-721 transfers with lowercased addresses and decimal token ids', async () => {
    const { env, bodies } = stub([{ body: { result: { transfers: [transfer(10, 3, { erc721TokenId: '0x0f' })] } } }]);
    const b = budgetFor(10, 0);
    const out = await readTransfers(env, b, { contract: C, standard: 'erc721', decimals: 0 }, 1, 20);
    expect(out.through).toBe(20);
    expect(out.rows).toEqual([
      expect.objectContaining({ block: 10, logIndex: 3, tx: '0xhash10', from: A, to: B, tokenId: '15', amount: 1 }),
    ]);
    expect(bodies[0].params[0]).toMatchObject({ fromBlock: '0x1', toBlock: '0x14', contractAddresses: [C], category: ['erc721'] });
    expect(b.calls).toBe(1);
  });

  it('splits an ERC-1155 batch into one row per token and scales ERC-20 amounts', async () => {
    const { env } = stub([
      { body: { result: { transfers: [transfer(5, 0, { erc1155Metadata: [{ tokenId: '0x1', value: '0x2' }, { tokenId: '0x2', value: '0x5' }] })] } } },
      { body: { result: { transfers: [transfer(6, 1, { rawContract: { value: '0x29a2241af62c0000' } })] } } },
    ]);
    const b = budgetFor(10, 0);
    const nft = await readTransfers(env, b, { contract: C, standard: 'erc1155', decimals: 0 }, 1, 9);
    expect(nft.rows.map((r) => [r.tokenId, r.amount])).toEqual([['1', 2], ['2', 5]]);
    const ft = await readTransfers(env, b, { contract: C, standard: 'erc20', decimals: 18 }, 1, 9);
    expect(ft.rows[0]).toMatchObject({ tokenId: null, amount: 3 });
  });

  it('leaves a block that a page cut through for the next read', async () => {
    const { env } = stub([
      { body: { result: { transfers: [transfer(7, 0, {}), transfer(8, 0, {}), transfer(9, 0, {})], pageKey: 'next' } } },
    ]);
    const out = await readTransfers(env, budgetFor(10, 0), { contract: C, standard: 'erc721', decimals: 0 }, 1, 100);
    expect(out.rows.map((r) => r.block)).toEqual([7, 8]);
    expect(out.through).toBe(8);
  });

  it('stops the run on a 429 instead of retrying into the limit', async () => {
    const { env, bodies } = stub([{ status: 429 }]);
    const b = budgetFor(10, 0);
    await expect(headBlock(env, b)).rejects.toBeInstanceOf(RateLimited);
    expect(b.limited).toBe(true);
    await expect(headBlock(env, b)).rejects.toBeInstanceOf(RateLimited);
    expect(bodies).toHaveLength(1);
  });

  it('never makes more calls than the budget allows', async () => {
    const { env, bodies } = stub([{ body: { result: '0x10' } }, { body: { result: '0x11' } }]);
    const b = budgetFor(1, 0);
    expect(await headBlock(env, b)).toBe(16);
    await expect(headBlock(env, b)).rejects.toThrow('out of calls');
    expect(bodies).toHaveLength(1);
  });

  it('reads transactions in one batch and skips ones Alchemy dropped', async () => {
    const { env, bodies } = stub([{ body: [{ id: 1, result: { from: A.toUpperCase().replace('0X', '0x'), to: null, value: '0x10' } }, { id: 0, error: { message: 'gone' } }] }]);
    const out = await txDetails(env, budgetFor(10, 0), ['0xt0', '0xt1']);
    expect(bodies[0]).toHaveLength(2);
    expect([...out]).toEqual([['0xt1', { from: A, to: '', value: '16' }]]);
  });

  it('does not crash on a page whose transfers parse to no rows', async () => {
    const { env } = stub([
      { body: { result: { transfers: [transfer(7, 0, { erc1155Metadata: [] }), transfer(9, 0, { erc1155Metadata: [] })], pageKey: 'next' } } },
    ]);
    const out = await readTransfers(env, budgetFor(10, 0), { contract: C, standard: 'erc1155', decimals: 0 }, 1, 100);
    expect(out).toEqual({ rows: [], through: 8 });
  });

  it('asks for internal transfers only where Alchemy has them', async () => {
    const { env, bodies } = stub([{ body: { result: { transfers: [] } } }, { body: { result: { transfers: [] } } }]);
    await funderOf(env, budgetFor(10, 0), A);
    await funderOf({ ...env, internalTransfers: true }, budgetFor(10, 0), A);
    expect(bodies.map((x) => x.params[0].category)).toEqual([['external'], ['external', 'internal']]);
  });

  it('only reports ENS lookups that happened', async () => {
    // Out of calls: nothing was looked up, so nothing may be marked as named.
    const { env } = stub([]);
    const none = await ensNames(env, budgetFor(0, 0), [A, B]);
    expect(none.size).toBe(0);
    // A broken resolver reverts the batch: split until the bad wallet is alone, which counts as no name.
    const revert = { body: { error: { code: 3, message: 'execution reverted' } } };
    const names = '0x' + (await import('viem')).encodeAbiParameters([{ type: 'string[]' }], [['bob.eth']]).slice(2);
    const { env: env2 } = stub([revert, revert, { body: { result: names } }]);
    const got = await ensNames(env2, budgetFor(10, 0), [A, B]);
    expect([...got]).toEqual([[A, null], [B, 'bob.eth']]);
  });

  it('turns raw ERC-20 amounts into whole tokens', () => {
    expect(units(1500000n, 6)).toBe(1.5);
    expect(units(0n, 18)).toBe(0);
  });
});
