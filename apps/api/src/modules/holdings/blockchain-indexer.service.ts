import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CHAIN_META } from '@nexus/types';

export interface WalletHolding {
  contractAddress: string;
  tokenCount: number;
}

export interface WalletHoldingsResult {
  holdings: WalletHolding[];
  /**
   * False when a page cap truncated the fetch. Reconciliation must not
   * delete rows for a chain whose fetch was incomplete — a missing holding
   * may simply be beyond the cap, not sold.
   */
  complete: boolean;
}

// Safety caps so a single degenerate wallet (airdrop magnet) can't run the
// job forever. Truncation is logged loudly — it means holdings beyond the
// cap are not indexed and must never be treated as "sold".
const EVM_MAX_PAGES = 50; // × 100 NFTs/page = 5,000 NFTs per chain
const SOLANA_MAX_PAGES = 10; // × 1,000 assets/page = 10,000 assets

/**
 * Fetches wallet holdings from Alchemy (EVM) / Helius (Solana).
 *
 * Failure semantics matter here: downstream reconciliation deletes holdings
 * rows that are absent from a successful fetch, so any failure (missing API
 * key, HTTP error, network error) THROWS instead of returning an empty
 * array. An empty array strictly means "this wallet holds nothing".
 */
@Injectable()
export class BlockchainIndexerService {
  private readonly logger = new Logger(BlockchainIndexerService.name);

  constructor(private readonly config: ConfigService) {}

  async fetchWalletHoldings(
    address: string,
    chain: string,
  ): Promise<WalletHoldingsResult> {
    if (chain === 'solana') {
      return this.fetchSolanaHoldings(address);
    }

    return this.fetchEvmHoldings(address, chain);
  }

  private async fetchEvmHoldings(
    address: string,
    chain: string,
  ): Promise<WalletHoldingsResult> {
    const apiKey = this.config.get<string>('alchemy.apiKey');
    if (!apiKey) {
      throw new Error('ALCHEMY_API_KEY not set - cannot fetch EVM holdings');
    }

    const meta = CHAIN_META[chain as keyof typeof CHAIN_META];
    if (!meta?.alchemySubdomain) {
      throw new Error(`No Alchemy support for chain: ${chain}`);
    }

    const url = `https://${meta.alchemySubdomain}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner`;

    const holdings = new Map<string, number>();
    let totalNfts = 0;
    let pageKey: string | undefined;
    let pages = 0;
    let complete = true;

    do {
      const params = new URLSearchParams({
        owner: address,
        withMetadata: 'false',
        pageSize: '100',
      });
      if (pageKey) params.set('pageKey', pageKey);

      const res = await fetch(`${url}?${params}`);
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(
          `Alchemy getNFTsForOwner error for ${address} on ${chain}: ${res.status} - ${errorText.slice(0, 200)}`,
        );
      }

      const body = (await res.json()) as AlchemyNFTsResponse;

      if (!body.ownedNfts || !Array.isArray(body.ownedNfts)) {
        throw new Error(
          `Unexpected Alchemy response format for ${address} on ${chain}: ${JSON.stringify(body).slice(0, 200)}`,
        );
      }

      for (const nft of body.ownedNfts) {
        // Handle both v2 and v3 response formats
        const contractAddress = nft.contract?.address || nft.contractAddress;
        if (!contractAddress) {
          this.logger.debug(`Skipping NFT with missing contract address: ${JSON.stringify(nft).slice(0, 100)}`);
          continue;
        }
        const contract = contractAddress.toLowerCase();
        holdings.set(contract, (holdings.get(contract) || 0) + 1);
      }

      totalNfts += body.ownedNfts.length;
      pageKey = body.pageKey;
      pages++;

      if (pageKey && pages >= EVM_MAX_PAGES) {
        this.logger.warn(
          `EVM holdings truncated for ${address} on ${chain}: hit ${EVM_MAX_PAGES}-page cap (${totalNfts} NFTs indexed, more exist)`,
        );
        pageKey = undefined;
        complete = false;
      }
    } while (pageKey);

    const result = Array.from(holdings.entries()).map(([contractAddress, tokenCount]) => ({
      contractAddress,
      tokenCount,
    }));

    this.logger.log(
      `Fetched ${result.length} collections (${totalNfts} total NFTs, ${pages} page${pages === 1 ? '' : 's'}) for ${address} on ${chain}`,
    );

    return { holdings: result, complete };
  }

  private async fetchSolanaHoldings(address: string): Promise<WalletHoldingsResult> {
    const apiKey = this.config.get<string>('helius.apiKey');
    if (!apiKey) {
      throw new Error('HELIUS_API_KEY not set - cannot fetch Solana holdings');
    }

    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    const pageLimit = 1000;

    const holdings = new Map<string, number>();
    let totalAssets = 0;
    let page = 1;
    let complete = true;

    for (;;) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAssetsByOwner',
          params: {
            ownerAddress: address,
            page,
            limit: pageLimit,
            displayOptions: {
              showCollectionMetadata: true,
            },
          },
        }),
      });

      if (!res.ok) {
        throw new Error(`Helius getAssetsByOwner error for ${address}: ${res.status}`);
      }

      const body = (await res.json()) as HeliusAssetsResponse;
      if (body.error) {
        throw new Error(
          `Helius getAssetsByOwner RPC error for ${address}: ${JSON.stringify(body.error).slice(0, 200)}`,
        );
      }
      const items = body.result?.items || [];

      for (const asset of items) {
        const collection = asset.grouping?.find((g) => g.group_key === 'collection');
        if (collection?.group_value) {
          const addr = collection.group_value;
          holdings.set(addr, (holdings.get(addr) || 0) + 1);
        }
      }

      totalAssets += items.length;

      if (items.length < pageLimit) break;
      if (page >= SOLANA_MAX_PAGES) {
        this.logger.warn(
          `Solana holdings truncated for ${address}: hit ${SOLANA_MAX_PAGES}-page cap (${totalAssets} assets indexed, more exist)`,
        );
        complete = false;
        break;
      }
      page++;
    }

    const result = Array.from(holdings.entries()).map(([contractAddress, tokenCount]) => ({
      contractAddress,
      tokenCount,
    }));

    this.logger.log(
      `Fetched ${result.length} collections (${totalAssets} total NFTs, ${page} page${page === 1 ? '' : 's'}) for ${address} on Solana`,
    );

    return { holdings: result, complete };
  }
}

interface AlchemyNFTsResponse {
  ownedNfts: Array<{
    contract?: { address: string };
    contractAddress?: string;
    tokenId?: string;
  }>;
  totalCount?: number;
  pageKey?: string;
}

interface HeliusAssetsResponse {
  error?: { code?: number; message?: string };
  result?: {
    items: {
      id: string;
      grouping?: { group_key: string; group_value: string }[];
    }[];
  };
}
