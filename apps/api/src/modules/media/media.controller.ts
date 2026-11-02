import { Controller, Get, NotFoundException, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { MediaService } from './media.service';
import { parseIpfsTarget } from './ipfs';

@ApiTags('media')
// A page can show dozens of images; the API's per-visitor limit is meant for data calls.
@SkipThrottle()
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

    const image = await this.media.ipfsImage(target.cid, target.path);
    if (!image) {
      // Gateways can be briefly unavailable, so don't let a miss stick in caches for long.
      res.setHeader('Cache-Control', 'public, max-age=300');
      throw new NotFoundException('Image not found on IPFS');
    }

    res.setHeader('Content-Type', image.type);
    // Content under a CID never changes.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // An SVG opened directly must not run scripts on the site's origin.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    res.send(image.body);
  }
}
