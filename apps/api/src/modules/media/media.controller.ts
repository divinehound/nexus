import { Controller, Get, NotFoundException, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { MediaService } from './media.service';
import { parseIpfsTarget } from './ipfs';

@ApiTags('media')
// A page can show dozens of images, more than the API's default per-visitor limit allows.
// nginx caches the answers, so this mostly limits fetches of images nobody has asked for yet.
@Throttle({ default: { limit: 300, ttl: 60_000 } })
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get('ipfs/*rest')
  @ApiOperation({ summary: 'An image stored on IPFS, fetched through a gateway: /media/ipfs/<cid>/<path>' })
  async ipfs(@Req() req: Request, @Res() res: Response) {
    // Parse the raw path so encoded characters reach the gateway as they were.
    const rest = req.path.slice(req.path.indexOf('/media/ipfs/') + '/media/ipfs/'.length);
    const target = parseIpfsTarget(rest);
    if (!target) throw new NotFoundException('Not an IPFS image address');

    const result = await this.media.ipfsImage(target.cid, target.path);
    if (result.kind !== 'image') {
      if (result.kind === 'missing') {
        // Not cached for long, in case a gateway just hadn't found the content yet.
        res.setHeader('Cache-Control', 'public, max-age=300');
        throw new NotFoundException('Image not found on IPFS');
      }
      // Gateways down or the proxy busy: don't let this stick in any cache.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', '30');
      throw new ServiceUnavailableException(
        result.kind === 'busy' ? 'Too many images loading, try again shortly' : 'IPFS gateways are unavailable',
      );
    }

    const { image } = result;
    res.setHeader('Content-Type', image.type);
    // Content under a CID never changes.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline; filename="image"');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // An SVG opened directly must not run scripts on the site's origin.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    res.send(image.body);
  }
}
