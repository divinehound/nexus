/** CIDv0 (base58 "Qm…") or CIDv1 in base32 ("b…"), the two forms NFT metadata uses. */
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
/** One path segment inside the CID's directory, still URL-encoded. */
const SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@%|[\]^-]+$/;

/** A segment that stays one segment once decoded: no "/", "\\", "." or "..", even encoded. */
function isSafeSegment(segment: string): boolean {
  if (!SEGMENT.test(segment)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return false;
  }
  return decoded !== '.' && decoded !== '..' && !/[/\\]/.test(decoded);
}

/** The parts of /api/media/ipfs/<cid>/<path…> after "ipfs/", or null when they aren't valid. */
export function parseIpfsTarget(rest: string): { cid: string; path: string } | null {
  const [cid, ...segments] = rest.split('/');
  if (!CID.test(cid)) return null;
  if (segments.length > 20) return null;
  // A trailing slash leaves an empty last segment; ignore it.
  if (segments.length && segments[segments.length - 1] === '') segments.pop();
  if (!segments.every(isSafeSegment)) return null;
  return { cid, path: segments.join('/') };
}

const SIGNATURES: [string, (b: Buffer) => boolean][] = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['image/avif', (b) => b.subarray(4, 12).toString('latin1') === 'ftypavif'],
  ['image/svg+xml', (b) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(b.subarray(0, 1024).toString('utf8'))],
];

/**
 * The image type of a gateway response: what the gateway said if it's an image, otherwise
 * what the bytes look like (gateways often say application/octet-stream). Null for anything
 * that isn't an image, so the proxy never serves HTML or scripts from the site's origin.
 */
export function imageType(declared: string | null, body: Buffer): string | null {
  const type = (declared ?? '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('image/')) return type;
  return SIGNATURES.find(([, matches]) => matches(body))?.[0] ?? null;
}
