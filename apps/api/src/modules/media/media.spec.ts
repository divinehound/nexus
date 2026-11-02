import { ConfigService } from '@nestjs/config';
import { imageType, parseIpfsTarget } from './ipfs';
import { MAX_IMAGE_BYTES, MediaService } from './media.service';

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
  const service = new MediaService({ get: () => ['https://a.example', 'https://b.example'] } as unknown as ConfigService);
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const response = (body: Buffer, init: ResponseInit = {}) => new Response(new Uint8Array(body), init);

  it('falls back to the next gateway', async () => {
    fetchMock
      .mockResolvedValueOnce(response(Buffer.from('nope'), { status: 403 }))
      .mockResolvedValueOnce(response(PNG, { headers: { 'content-type': 'application/octet-stream' } }));
    const image = await service.ipfsImage(V1, 'a.png');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `https://a.example/ipfs/${V1}/a.png`,
      `https://b.example/ipfs/${V1}/a.png`,
    ]);
    expect(image?.type).toBe('image/png');
  });

  it('gives up on non-images and oversized files', async () => {
    fetchMock
      .mockResolvedValueOnce(response(Buffer.from('<html>'), { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(response(Buffer.alloc(MAX_IMAGE_BYTES + 1)));
    expect(await service.ipfsImage(V1, '')).toBeNull();
  });
});
