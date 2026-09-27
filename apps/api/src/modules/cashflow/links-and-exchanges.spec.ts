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
