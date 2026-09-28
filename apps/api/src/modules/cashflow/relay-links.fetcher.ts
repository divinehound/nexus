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
