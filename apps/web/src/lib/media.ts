import { API_BASE } from '@/lib/api';

const CID = String.raw`(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})`;
/** ipfs://<cid>/…, or any gateway URL: https://host/ipfs/<cid>/… or https://<cid>.ipfs.host/… */
const IPFS_SCHEME = new RegExp(`^ipfs://(?:ipfs/)?${CID}(/[^?#]*)?`);
const GATEWAY_PATH = new RegExp(`^https?://[^/]+/ipfs/${CID}(/[^?#]*)?`);
const GATEWAY_SUBDOMAIN = new RegExp(`^https?://${CID}\\.ipfs\\.[^/]+(/[^?#]*)?`);

/**
 * The URL to show an NFT image from. Public IPFS gateways (ipfs.io and others) refuse to be
 * embedded on other sites, so IPFS images go through the API's image proxy instead.
 * Other URLs are returned unchanged.
 */
export function mediaUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const match = IPFS_SCHEME.exec(url) ?? GATEWAY_PATH.exec(url) ?? GATEWAY_SUBDOMAIN.exec(url);
  if (!match) return url;
  const [, cid, path = ''] = match;
  return `${API_BASE}/media/ipfs/${cid}${path.replace(/\/+$/, '')}`;
}
