import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CHAIN_META } from '@nexus/types';

export interface WalletHolding {
  contractAddress: string;
  tokenCount: number;
}

@Injectable()
export class BlockchainIndexerService {
  private readonly logger = new Logger(BlockchainIndexerService.name);

  constructor(private readonly config: ConfigService) {}

  async fetchWalletHoldings(
    address: string,
    chain: string,
  ): Promise<WalletHolding[]> {
    if (chain === 'solana') {
      return this.fetchSolanaHoldings(address);
    }

    return this.fetchEvmHoldings(address, chain);
  }

  private async fetchEvmHoldings(
    address: string,
    chain: string,
  ): Promise<WalletHolding[]> {
    const apiKey = this.config.get<string>('alchemy.apiKey');
    if (!apiKey) {
      this.logger.warn('ALCHEMY_API_KEY not set - cannot fetch EVM holdings');
      return [];
    }

    const meta = CHAIN_META[chain as keyof typeof CHAIN_META];
    if (!meta?.alchemySubdomain) {
      this.logger.warn(`No Alchemy support for chain: ${chain}`);
      return [];
    }

    const url = `https://${meta.alchemySubdomain}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner`;

    try {
      const params = new URLSearchParams({
        owner: address,
        withMetadata: 'false',
        pageSize: '100',
      });

      const res = await fetch(`${url}?${params}`);
      if (!res.ok) {
        this.logger.error(
          `Alchemy getNFTsForOwner error for ${address} on ${chain}: ${res.status}`,
        );
        return [];
      }

      const body = (await res.json()) as AlchemyNFTsResponse;

      // Group by contract address and count tokens
      const holdings = new Map<string, number>();
      for (const nft of body.ownedNfts) {
        const contract = nft.contract.address.toLowerCase();
        holdings.set(contract, (holdings.get(contract) || 0) + 1);
      }

      const result = Array.from(holdings.entries()).map(([contractAddress, tokenCount]) => ({
        contractAddress,
        tokenCount,
      }));

      this.logger.log(
        `Fetched ${result.length} collections (${body.ownedNfts.length} total NFTs) for ${address} on ${chain}`,
      );

      return result;
    } catch (err) {
      this.logger.error(`Failed to fetch EVM holdings for ${address} on ${chain}: ${err}`);
      return [];
    }
  }

  private async fetchSolanaHoldings(address: string): Promise<WalletHolding[]> {
    const apiKey = this.config.get<string>('helius.apiKey');
    if (!apiKey) {
      this.logger.warn('HELIUS_API_KEY not set - cannot fetch Solana holdings');
      return [];
    }

    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAssetsByOwner',
          params: {
            ownerAddress: address,
            page: 1,
            limit: 1000,
            displayOptions: {
              showCollectionMetadata: true,
            },
          },
        }),
      });

      if (!res.ok) {
        this.logger.error(`Helius getAssetsByOwner error for ${address}: ${res.status}`);
        return [];
      }

      const body = (await res.json()) as HeliusAssetsResponse;
      const items = body.result?.items || [];

      // Group by collection mint address
      const holdings = new Map<string, number>();
      for (const asset of items) {
        const collection = asset.grouping?.find((g) => g.group_key === 'collection');
        if (collection?.group_value) {
          const addr = collection.group_value;
          holdings.set(addr, (holdings.get(addr) || 0) + 1);
        }
      }

      const result = Array.from(holdings.entries()).map(([contractAddress, tokenCount]) => ({
        contractAddress,
        tokenCount,
      }));

      this.logger.log(
        `Fetched ${result.length} collections (${items.length} total NFTs) for ${address} on Solana`,
      );

      return result;
    } catch (err) {
      this.logger.error(`Failed to fetch Solana holdings for ${address}: ${err}`);
      return [];
    }
  }
}

interface AlchemyNFTsResponse {
  ownedNfts: {
    contract: { address: string };
    tokenId: string;
  }[];
  totalCount: number;
  pageKey?: string;
}

interface HeliusAssetsResponse {
  result?: {
    items: {
      id: string;
      grouping?: { group_key: string; group_value: string }[];
    }[];
  };
}
