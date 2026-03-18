import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Chain,
  CHAIN_META,
  isEvmAddress,
  isSolanaAddress,
  isEvmChain,
  type BlockchainContractInfo,
} from '@nexus/types';

@Injectable()
export class BlockchainLookupService {
  private readonly logger = new Logger(BlockchainLookupService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Look up contract metadata on-chain.
   * If chain is specified, only queries that chain.
   * Otherwise tries EVM chains with Alchemy support, then Solana.
   */
  async lookup(
    address: string,
    chain?: string,
  ): Promise<BlockchainContractInfo[]> {
    if (chain) {
      const result = await this.lookupOnChain(address, chain as Chain);
      return result ? [result] : [];
    }

    // No chain specified — try matching chains
    const results: BlockchainContractInfo[] = [];

    if (isEvmAddress(address)) {
      // Try EVM chains with Alchemy support (stop on first hit)
      for (const c of Object.values(Chain)) {
        if (!isEvmChain(c)) continue;
        const meta = CHAIN_META[c];
        if (!meta.alchemySubdomain) continue;

        const result = await this.lookupEvm(address, c);
        if (result) {
          results.push(result);
          break; // Contract exists on one chain — stop searching
        }
      }
    } else if (isSolanaAddress(address)) {
      const result = await this.lookupSolana(address);
      if (result) results.push(result);
    }

    return results;
  }

  private async lookupOnChain(
    address: string,
    chain: Chain,
  ): Promise<BlockchainContractInfo | null> {
    if (chain === Chain.SOLANA) {
      return this.lookupSolana(address);
    }
    if (isEvmChain(chain)) {
      return this.lookupEvm(address, chain);
    }
    return null;
  }

  /**
   * Query Alchemy NFT API v3 for EVM contract metadata.
   */
  private async lookupEvm(
    contractAddress: string,
    chain: Chain,
  ): Promise<BlockchainContractInfo | null> {
    const apiKey = this.config.get<string>('alchemy.apiKey');
    if (!apiKey) {
      this.logger.warn('ALCHEMY_API_KEY not set — skipping blockchain lookup');
      return null;
    }

    const meta = CHAIN_META[chain];
    if (!meta.alchemySubdomain) {
      this.logger.debug(`No Alchemy support for ${meta.name}`);
      return null;
    }

    const url = `https://${meta.alchemySubdomain}.g.alchemy.com/nft/v3/${apiKey}/getContractMetadata?contractAddress=${contractAddress}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) return null;
        this.logger.error(`Alchemy getContractMetadata error (${meta.name}): ${res.status}`);
        return null;
      }

      const body = (await res.json()) as AlchemyContractMetadata;

      // If the contract has no name, it's likely not an NFT contract
      if (!body.name && !body.symbol) return null;

      const tokenType = body.tokenType?.toLowerCase().includes('1155')
        ? 'erc1155'
        : 'erc721';

      return {
        contractAddress,
        chain,
        name: body.name || `Unknown (${contractAddress.slice(0, 8)}...)`,
        symbol: body.symbol || '',
        totalSupply: body.totalSupply ? parseInt(body.totalSupply, 10) : null,
        tokenType: tokenType as 'erc721' | 'erc1155',
        imageUrl: body.openSeaMetadata?.imageUrl ?? null,
        deployerAddress: body.contractDeployer ?? null,
      };
    } catch (err) {
      this.logger.error(`Blockchain lookup failed (${meta.name}): ${err}`);
      return null;
    }
  }

  /**
   * Query Helius DAS API for Solana asset metadata.
   */
  private async lookupSolana(
    mintAddress: string,
  ): Promise<BlockchainContractInfo | null> {
    const apiKey = this.config.get<string>('helius.apiKey');
    if (!apiKey) {
      this.logger.warn('HELIUS_API_KEY not set — skipping Solana lookup');
      return null;
    }

    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAsset',
          params: { id: mintAddress },
        }),
      });

      if (!res.ok) return null;

      const body = (await res.json()) as HeliusGetAssetResponse;
      const asset = body.result;
      if (!asset) return null;

      return {
        contractAddress: mintAddress,
        chain: Chain.SOLANA,
        name: asset.content?.metadata?.name || `Unknown (${mintAddress.slice(0, 8)}...)`,
        symbol: asset.content?.metadata?.symbol || '',
        totalSupply: asset.supply?.print_max_supply ?? null,
        tokenType: 'spl',
        imageUrl: asset.content?.links?.image ?? null,
        deployerAddress: asset.authorities?.[0]?.address ?? null,
      };
    } catch (err) {
      this.logger.error(`Solana blockchain lookup failed: ${err}`);
      return null;
    }
  }
}

interface AlchemyContractMetadata {
  name?: string;
  symbol?: string;
  totalSupply?: string;
  tokenType?: string;
  contractDeployer?: string;
  deployedBlockNumber?: number;
  openSeaMetadata?: {
    imageUrl?: string;
    collectionName?: string;
    description?: string;
  };
}

interface HeliusGetAssetResponse {
  result?: {
    content?: {
      metadata?: { name?: string; symbol?: string };
      links?: { image?: string };
    };
    supply?: { print_max_supply?: number };
    authorities?: { address: string }[];
  };
}
