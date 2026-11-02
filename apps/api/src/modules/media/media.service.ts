import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { imageType } from './ipfs';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export interface Image {
  type: string;
  body: Buffer;
}

/**
 * Fetches IPFS images server-side. Public gateways such as ipfs.io refuse to be embedded
 * on other sites (they answer browsers with Cross-Origin-Resource-Policy: same-origin or a
 * 403), but a server can still read them, so the web app shows them through this proxy.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly gateways: string[];

  constructor(config: ConfigService) {
    this.gateways = config.get<string[]>('ipfs.gateways') ?? [];
  }

  /** The image at ipfs://<cid>/<path>, from the first gateway that has it, or null. */
  async ipfsImage(cid: string, path: string): Promise<Image | null> {
    for (const gateway of this.gateways) {
      const url = `${gateway}/ipfs/${cid}${path ? `/${path}` : ''}`;
      try {
        const image = await this.fetchImage(url);
        if (image) return image;
      } catch (err) {
        this.logger.debug(`${url}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return null;
  }

  private async fetchImage(url: string): Promise<Image | null> {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
    if (!res.ok || !res.body) return null;
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_IMAGE_BYTES) return null;

    // Read with a cap, since content-length can be missing or wrong.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_IMAGE_BYTES) return null;
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    const type = imageType(res.headers.get('content-type'), body);
    return type ? { type, body } : null;
  }
}
