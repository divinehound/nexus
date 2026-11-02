import { ConfigService } from '@nestjs/config';
import { imageType, parseIpfsTarget } from './ipfs';
import { MAX_CONCURRENT, MAX_IMAGE_BYTES, MediaService } from './media.service';

const V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const V1 = 'bafybeiese3bgyfewt2r3dxvgups2blc3rwh2utvidirxgxq527mhcv3ydy';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe('parseIpfsTarget', () => {
  it('accepts v0 and v1 CIDs, with or without a path', () => {
    expect(parseIpfsTarget(V0)).toEqual({ cid: V0, path: '' });
    expect(parseIpfsTarget(`${V1}/`)).toEqual({ cid: V1, path: '' });
    expect(parseIpfsTarget(`${V1}/images/1%20a.png`)).toEqual({ cid: V1, path: 'images/1%20a.png' });
  });

  it('rejects anything else', () => {
    expect(parseIpfsTarget('not-a-cid')).toBeNull();
    expect(parseIpfsTarget(`${V1}/../etc`)).toBeNull();
    expect(parseIpfsTarget(`${V1}/a//b`)).toBeNull();
    expect(parseIpfsTarget(`${V1}/a?b`)).toBeNull();
    expect(parseIpfsTarget(`${V1}/..%2F..`)).toBeNull();
    expect(parseIpfsTarget(`${V1}/%2e%2e`)).toBeNull();
    expect(parseIpfsTarget(`${V1}/a%5Cb`)).toBeNull();
    expect(parseIpfsTarget(`${V1}/%zz`)).toBeNull();
  });

  it('accepts names the web app encodes', () => {
    expect(parseIpfsTarget(`${V1}/My%20Image%20%5B1%5D.png`)?.path).toBe('My%20Image%20%5B1%5D.png');
    expect(parseIpfsTarget(`${V0.slice(0, -1)}`)).toBeNull();
  });
});

describe('imageType', () => {
  it("trusts the gateway's image type", () => {
    expect(imageType('image/png; charset=binary', Buffer.from('x'))).toBe('image/png');
  });

  it('sniffs images sent as octet-stream', () => {
    expect(imageType('application/octet-stream', PNG)).toBe('image/png');
    expect(imageType(null, Buffer.from('<?xml version="1.0"?>\n<svg xmlns="x"></svg>'))).toBe('image/svg+xml');
  });

  it('refuses HTML and other non-images', () => {
    expect(imageType('text/html', Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(imageType('application/json', Buffer.from('{"image":"x"}'))).toBeNull();
  });
});

describe('MediaService', () => {
  const service = () =>
    new MediaService({ get: () => ['https://a.example', 'https://b.example'] } as unknown as ConfigService);
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const response = (body: Buffer | null, init: ResponseInit = {}) =>
    new Response(body && new Uint8Array(body), init);
  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

  it('falls back to the next gateway', async () => {
    fetchMock
      .mockResolvedValueOnce(response(Buffer.from('nope'), { status: 429 }))
      .mockResolvedValueOnce(response(PNG, { headers: { 'content-type': 'application/octet-stream' } }));
    const result = await service().ipfsImage(V1, 'a.png');
    expect(urls()).toEqual([`https://a.example/ipfs/${V1}/a.png`, `https://b.example/ipfs/${V1}/a.png`]);
    expect(result.kind === 'image' && result.image.type).toBe('image/png');
  });

  it('says missing when a gateway answered, unavailable when none did', async () => {
    fetchMock
      .mockResolvedValueOnce(response(Buffer.from('<html>'), { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(response(Buffer.alloc(MAX_IMAGE_BYTES + 1)));
    expect((await service().ipfsImage(V1, '')).kind).toBe('missing');

    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(response(null, { status: 502 }));
    expect((await service().ipfsImage(V1, '')).kind).toBe('unavailable');
  });

  it('follows redirects only within the gateway', async () => {
    fetchMock
      .mockResolvedValueOnce(response(null, { status: 301, headers: { location: `https://${V1}.ipfs.a.example/` } }))
      .mockResolvedValueOnce(response(PNG))
      .mockResolvedValueOnce(response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }));
    const s = service();
    expect((await s.ipfsImage(V1, '')).kind).toBe('image');
    expect(urls()[1]).toBe(`https://${V1}.ipfs.a.example/`);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }))
      .mockResolvedValueOnce(response(null, { status: 404 }));
    expect((await s.ipfsImage(V0, '')).kind).toBe('missing');
    expect(urls()).not.toContain('http://169.254.169.254/latest');
  });

  it('shares one fetch between identical requests and caps how many run at once', async () => {
    const releases: (() => void)[] = [];
    fetchMock.mockImplementation(
      () => new Promise((resolve) => releases.push(() => resolve(response(PNG)))),
    );
    const s = service();
    const same = [s.ipfsImage(V1, 'x.png'), s.ipfsImage(V1, 'x.png')];
    const others = Array.from({ length: MAX_CONCURRENT + 4 }, (_, i) => s.ipfsImage(V1, `${i}.png`));
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT);

    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setImmediate(r));
    }
    const results = await Promise.all([...same, ...others]);
    expect(results.every((r) => r.kind === 'image')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT + 5);
  });
});
