import { Logger } from '@nestjs/common';
import type { ExplicitLink } from './cashflow-ledger';
import { fetchJsonWithRetry, sleep } from './http';

/** Relay chain ids → our chain names (Solana uses Relay's own id). */
export const RELAY_CHAIN_IDS: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  137: 'polygon',
  2741: 'abstract',
  33139: 'apechain',
  42161: 'arbitrum',
  10: 'optimism',
  7777777: 'zora',
  81457: 'blast',
  59144: 'linea',
  4663: 'robinhood',
  792703809: 'solana',
};

/**
 * Where a Relay payment goes on the paying chain: the RelayReceiver, the
 * depositories, every router version, and the solvers (from Relay's docs:
 * API "Contract Addresses" and Protocol "Depository addresses"). Used to pair
 * a payment with the mint/purchase Relay delivers on another chain when
 * Relay's own records aren't available.
 */
export const RELAY_PAYEES: Array<{ chain: 'ethereum' | 'solana'; address: string }> = [
  ...[
    '0xa5f565650890fba1824ee0f21ebbbf660a179934', // RelayReceiver
    '0x4cd00e387622c35bddb9b4c962c136462338bc31', // Depository
    '0x59916da825d2d2ec1bf878d71c88826f6633ecca', // Depository (some chains)
    '0xf70da97812cb96acdf810712aa562db8dfa3dbef', // EVM solver
    '0x113a327221d2c4660684449bfc39bc14ad1aaf38', // v2 Router
    '0xf5042e6ffac5a625d4e7848e0b01373d8eb9e222',
    '0x8fdceeda2951a9747feaf25311435448bce47b2a',
    '0xb758f3bfa7b9d39ef5457d7c7ffb3702f2ad3982', // v2.1 Router
    '0x3ec130b627944cad9b2750300ecb0a695da522b6',
    '0x9ef6d3c2f60d7b9008d74cab1fc0f899c957c819', // v3 Router
    '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f',
    '0xe16870b028704e38dbc254a84d3f72c8ba345ca9',
    '0xcd740b0e005cb8647f9baf4febedc8753ceef861', // ApprovalProxy v2 / v2.1 / v3
    '0xbbbfd134e9b44bfb5123898ba36b01de7ab93d98',
    '0xaec31c3780521c34ca59dc2eb5fb9ee2e285cebe',
    '0x953c95146eb8ce763f35caf2f1d46ddf6a33bea2',
    '0x58cc3e0aa6cd7bf795832a225179ec2d848ce3e7',
    '0x8754bc615047de01228a7527b712806a71a8dc9a',
    '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be',
    '0xf6e54bbf91e564fcf0df3ed9f2dd82913e9232c3',
  ].map((address) => ({ chain: 'ethereum' as const, address })),
  { chain: 'solana', address: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2' }, // Solana depository
  { chain: 'solana', address: 'F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe' }, // SVM solver
];

const MAX_PAGES = 20; // × 50 requests per address

interface RelayTx {
  txHash?: string;
  chainId?: number;
}

export interface RelayRequest {
  id?: string;
  status?: string;
  data?: { inTxs?: RelayTx[]; outTxs?: RelayTx[] };
}

/**
 * Turn one Relay request into a link between its origin (deposit) tx and its
 * destination (fill) tx. Only successful, single-hop requests on chains we
 * scan are usable.
 */
export function relayRequestToLink(r: RelayRequest): ExplicitLink | null {
  if (r.status !== 'success') return null;
  const from = r.data?.inTxs?.[0];
  const to = r.data?.outTxs?.[0];
  if (!from?.txHash || !to?.txHash || from.chainId === undefined || to.chainId === undefined) return null;
  const fromChain = RELAY_CHAIN_IDS[from.chainId];
  const toChain = RELAY_CHAIN_IDS[to.chainId];
  if (!fromChain || !toChain || fromChain === toChain) return null;
  return { fromChain, fromTxHash: from.txHash, toChain, toTxHash: to.txHash, source: 'relay' };
}

/**
 * Pulls a wallet's Relay history (GET /requests/v3, which requires an API key)
 * so bridges through Relay are paired from Relay's own records — exact even
 * when the trip is slow or the fee is large.
 */
export class RelayLinksFetcher {
  private readonly logger = new Logger(RelayLinksFetcher.name);

  constructor(private readonly apiKey: string) {}

  async fetchLinks(address: string): Promise<ExplicitLink[]> {
    const links: ExplicitLink[] = [];
    let continuation: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL('https://api.relay.link/requests/v3');
      url.searchParams.set('user', address);
      url.searchParams.set('limit', '50');
      if (continuation) url.searchParams.set('continuation', continuation);
      const json = await fetchJsonWithRetry<{ requests?: RelayRequest[]; continuation?: string | null }>(
        url.toString(),
        { headers: { accept: 'application/json', 'x-api-key': this.apiKey } },
        'Relay requests',
        { retries: 3 },
      );
      for (const r of json.requests ?? []) {
        const link = relayRequestToLink(r);
        if (link) links.push(link);
      }
      continuation = json.continuation ?? undefined;
      if (!continuation || (json.requests ?? []).length === 0) break;
      await sleep(250);
    }
    this.logger.debug(`Relay: ${links.length} bridge records for ${address}`);
    return links;
  }
}
