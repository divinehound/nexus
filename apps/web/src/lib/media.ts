import { API_BASE } from '@/lib/api';

// The CID must end the segment, so a malformed one isn't cut down to a different valid CID.
const CID = String.raw`(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})(?=$|[/?#])`;
/** ipfs://<cid>/…, or any gateway URL: https://host/ipfs/<cid>/… or https://<cid>.ipfs.host/… */
const IPFS_SCHEME = new RegExp(`^ipfs://(?:ipfs/)?${CID}(/[^?#]*)?`);
const GATEWAY_PATH = new RegExp(`^https?://[^/]+/ipfs/${CID}(/[^?#]*)?`);
const GATEWAY_SUBDOMAIN = new RegExp(`^https?://(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})\\.ipfs\\.[^/]+(/[^?#]*)?`);

/**
 * The URL to show an NFT image from. Public IPFS gateways (ipfs.io and others) refuse to be
 * embedded on other sites, so IPFS images go through the API's image proxy instead.
 * Other URLs are returned unchanged.
 */
export function mediaUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  // Schemes are case-insensitive (IPFS://, HTTPS://); CIDs are not.
  const normalized = url.replace(/^[a-z]+:/i, (scheme) => scheme.toLowerCase());
  const match =
    IPFS_SCHEME.exec(normalized) ?? GATEWAY_PATH.exec(normalized) ?? GATEWAY_SUBDOMAIN.exec(normalized);
  if (!match) return url;
  const [, cid, path = ''] = match;
  // Re-encode each segment the same way, so names with spaces, brackets or "%" arrive intact.
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(safeDecode(segment)));
  return [`${API_BASE}/media/ipfs/${cid}`, ...segments].join('/');
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
