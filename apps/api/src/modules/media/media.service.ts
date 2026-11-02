import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { imageType } from './ipfs';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Per gateway. A CID nobody serves usually hangs rather than 404s, so keep this short. */
const TIMEOUT_MS = 8_000;
/** Gateway fetches in flight at once; each can hold up to MAX_IMAGE_BYTES. */
export const MAX_CONCURRENT = 16;
/** Fetches waiting for a slot. Past this, requests are turned away until the queue drains. */
export const MAX_QUEUED = 500;
const MAX_REDIRECTS = 3;

export interface Image {
  type: string;
  body: Buffer;
}

/**
 * - image: found.
 * - missing: a gateway answered, and it isn't there or isn't an image.
 * - unavailable: no gateway gave an answer (errors, timeouts, rate limits), so try again later.
 * - busy: too many fetches already waiting.
 */
export type ImageResult =
  | { kind: 'image'; image: Image }
  | { kind: 'missing' }
  | { kind: 'unavailable' }
  | { kind: 'busy' };

type Attempt = Image | 'missing' | 'unavailable';

/**
 * Fetches IPFS images server-side. Public gateways such as ipfs.io refuse to be embedded
 * on other sites (they answer browsers with Cross-Origin-Resource-Policy: same-origin or a
 * 403), but a server can still read them, so the web app shows them through this proxy.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly gateways: URL[];
  private readonly inFlight = new Map<string, Promise<ImageResult>>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(config: ConfigService) {
    this.gateways = (config.get<string[]>('ipfs.gateways') ?? []).map((g) => new URL(g));
  }

  /** The image at ipfs://<cid>/<path>. Concurrent requests for the same image share one fetch. */
  ipfsImage(cid: string, path: string): Promise<ImageResult> {
    const key = `${cid}/${path}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    if (this.waiting.length >= MAX_QUEUED) return Promise.resolve({ kind: 'busy' });

    const result = this.withSlot(() => this.fromGateways(cid, path)).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, result);
    return result;
  }

  /** Runs `task` once fewer than MAX_CONCURRENT are running. */
  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    // A finishing task hands its slot straight to the next waiter, so `active` never overshoots.
    if (this.active >= MAX_CONCURRENT) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async fromGateways(cid: string, path: string): Promise<ImageResult> {
    let answered = false;
    for (const gateway of this.gateways) {
      const url = new URL(`${gateway.pathname.replace(/\/+$/, '')}/ipfs/${cid}${path ? `/${path}` : ''}`, gateway);
      try {
        const attempt = await this.fetchImage(url, gateway);
        if (attempt === 'missing') answered = true;
        else if (attempt !== 'unavailable') return { kind: 'image', image: attempt };
      } catch (err) {
        this.logger.debug(`${url}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { kind: answered ? 'missing' : 'unavailable' };
  }

  private async fetchImage(start: URL, gateway: URL): Promise<Attempt> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let url = start;
    for (let hop = 0; ; hop++) {
      // Follow redirects by hand, and only within the gateway (e.g. dweb.link's move to
      // <cid>.ipfs.dweb.link), so content on IPFS can't send the API to other hosts.
      const res = await fetch(url, { signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        await discard(res);
        const next = res.headers.get('location');
        if (!next || hop >= MAX_REDIRECTS) return 'unavailable';
        url = new URL(next, url);
        if (!isGatewayUrl(url, gateway)) return 'unavailable';
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        await discard(res);
        return 'missing';
      }
      if (!res.ok || !res.body) {
        await discard(res);
        return 'unavailable';
      }
      if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) {
        await discard(res);
        return 'missing';
      }
      return readImage(res);
    }
  }
}

/** The gateway itself or one of its subdomains, over the same protocol (or upgraded to https). */
function isGatewayUrl(url: URL, gateway: URL): boolean {
  const sameProtocol = url.protocol === gateway.protocol || url.protocol === 'https:';
  const sameHost = url.host === gateway.host || url.hostname.endsWith(`.${gateway.hostname}`);
  return sameProtocol && sameHost;
}

/** Releases the connection of a response we won't read. */
async function discard(res: Response) {
  await res.body?.cancel().catch(() => undefined);
}

async function readImage(res: Response): Promise<Attempt> {
  // Read with a cap, since content-length can be missing or wrong. Leaving the loop early
  // cancels the stream.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_IMAGE_BYTES) return 'missing';
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks, size);
  const type = imageType(res.headers.get('content-type'), body);
  return type ? { type, body } : 'missing';
}
