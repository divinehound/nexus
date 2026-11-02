import { INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { MediaModule } from './media.module';

const CID = 'bafybeiese3bgyfewt2r3dxvgups2blc3rwh2utvidirxgxq527mhcv3ydy';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

describe('GET /api/media/ipfs/*', () => {
  let gateway: Server;
  let app: INestApplication;
  let base: string;
  const seen: string[] = [];

  beforeAll(async () => {
    gateway = createServer((req, res) => {
      seen.push(req.url!);
      if (req.url!.endsWith('.svg')) return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(SVG);
      if (req.url!.endsWith('.html')) return res.writeHead(200, { 'content-type': 'text/html' }).end('<script>');
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => gateway.listen(0, r));
    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

    @Module({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ ipfs: { gateways: [gatewayUrl] } })] }),
        MediaModule,
      ],
    })
    class TestModule {}

    app = await NestFactory.create(TestModule, { logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/media/ipfs`;
  });

  afterAll(async () => {
    await app.close();
    gateway.close();
  });

  it('serves images with immutable caching and headers that stop scripts', async () => {
    const res = await fetch(`${base}/${CID}/a%20b.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(seen).toContain(`/ipfs/${CID}/a%20b.svg`);
  });

  it('refuses non-images and bad addresses', async () => {
    const html = await fetch(`${base}/${CID}/x.html`);
    expect(html.status).toBe(404);
    expect(html.headers.get('cache-control')).toBe('public, max-age=300');
    expect((await fetch(`${base}/not-a-cid`)).status).toBe(404);
    expect((await fetch(`${base}/${CID}/..%2Fx`)).status).toBe(404);
  });
});
