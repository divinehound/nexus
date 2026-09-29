import { HolderVerificationService } from './holder-verification.service';

describe('HolderVerificationService (EVM)', () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const contract = '0x2222222222222222222222222222222222222222';
  let fetchMock: jest.Mock;
  let service: HolderVerificationService;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    const config = { get: jest.fn().mockReturnValue('test-key') };
    service = new HolderVerificationService(config as any);
  });

  const respond = (status: number, body: unknown) =>
    fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });

  it('queries getNFTsForOwner filtered to the contract', async () => {
    respond(200, { ownedNfts: [{ tokenId: '1' }], totalCount: 1 });

    await service.verifyHolder('ethereum', wallet, contract, '1');

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin).toBe('https://eth-mainnet.g.alchemy.com');
    expect(url.pathname).toBe('/nft/v3/test-key/getNFTsForOwner');
    expect(url.searchParams.get('owner')).toBe(wallet);
    expect(url.searchParams.getAll('contractAddresses[]')).toEqual([contract]);
    expect(url.searchParams.get('withMetadata')).toBe('false');
  });

  it('returns true when the wallet owns a token from the contract', async () => {
    respond(200, { ownedNfts: [{ tokenId: '1' }], totalCount: 1 });
    await expect(service.verifyHolder('ethereum', wallet, contract, '1')).resolves.toBe(true);
  });

  it('returns false when the wallet owns nothing from the contract', async () => {
    respond(200, { ownedNfts: [], totalCount: 0 });
    await expect(service.verifyHolder('ethereum', wallet, contract, '1')).resolves.toBe(false);
  });

  it('returns false on an Alchemy error response', async () => {
    respond(500, {});
    await expect(service.verifyHolder('ethereum', wallet, contract, '1')).resolves.toBe(false);
  });
});
