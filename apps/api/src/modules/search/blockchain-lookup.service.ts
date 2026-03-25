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
      if (!body.name && !body.symbol) {
        this.logger.log(`Alchemy returned no name/symbol for ${contractAddress} on ${meta.name} (tokenType: ${body.tokenType})`);
        return null;
      }

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
   * Query Helius DAS API for Solana collection metadata.
   * Uses getAsset with showCollectionMetadata for name, getAssetsByGroup for supply.
   */
  private async lookupSolana(
    collectionAddress: string,
  ): Promise<BlockchainContractInfo | null> {
    const apiKey = this.config.get<string>('helius.apiKey');
    if (!apiKey) {
      this.logger.warn('HELIUS_API_KEY not set — skipping Solana lookup');
      return null;
    }

    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    try {
      // Get collection metadata with showCollectionMetadata option
      const metadataRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAsset',
          params: {
            id: collectionAddress,
            displayOptions: {
              showCollectionMetadata: true,
            },
          },
        }),
      });

      if (!metadataRes.ok) {
        if (metadataRes.status === 429) {
          this.logger.warn(`[Solana Lookup] Rate limited on getAsset for ${collectionAddress}`);
          throw new Error('Rate limit hit (429)');
        }
        this.logger.warn(`[Solana Lookup] getAsset failed with status ${metadataRes.status}`);
        return null;
      }

      const metadataBody = await metadataRes.json();
      const asset = metadataBody.result;

      // Reject if no asset data or no name
      if (!asset?.content?.metadata?.name) {
        // This could be an individual NFT mint (not a collection) or invalid address
        this.logger.debug(`[Solana Lookup] No collection metadata for ${collectionAddress} - likely individual NFT or invalid`);
        return null;
      }

      // Small delay between API calls to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));

      // Get supply from getAssetsByGroup
      const supplyRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAssetsByGroup',
          params: {
            groupKey: 'collection',
            groupValue: collectionAddress,
            page: 1,
            limit: 1,
          },
        }),
      });

      let totalSupply = null;
      if (supplyRes.ok) {
        const supplyBody = await supplyRes.json();
        
        // The total field should contain the full collection size
        totalSupply = supplyBody.result?.total || null;
        
        // Also check the group object which might have collection info
        const groupTotal = supplyBody.result?.group?.total || null;
        
        // Log everything for debugging
        this.logger.log(`[Solana Lookup] getAssetsByGroup response for ${collectionAddress}:`, {
          'result.total': totalSupply,
          'result.group.total': groupTotal,
          'result.items.length': supplyBody.result?.items?.length || 0,
          'keys': Object.keys(supplyBody.result || {}),
        });
        
        // Use whichever total we found
        totalSupply = totalSupply || groupTotal || null;
        
        if (!totalSupply || totalSupply === 1) {
          this.logger.warn(`[Solana Lookup] Supply is ${totalSupply} for ${collectionAddress} - dumping full response`);
          this.logger.debug(JSON.stringify(supplyBody, null, 2));
        }
      } else {
        this.logger.warn(`[Solana Lookup] getAssetsByGroup failed with status ${supplyRes.status}`);
      }

      const name = asset.content.metadata.name;
      
      this.logger.log(`[Solana Lookup] Found: ${name}, supply: ${totalSupply || 'unknown'}`);

      return {
        contractAddress: collectionAddress,
        chain: Chain.SOLANA,
        name,
        symbol: asset.content?.metadata?.symbol || '',
        totalSupply,
        tokenType: 'spl',
        imageUrl: asset.content?.links?.image || asset.content?.files?.[0]?.uri || null,
        deployerAddress: asset.authorities?.[0]?.address || null,
      };
    } catch (err) {
      this.logger.error(`Solana blockchain lookup failed for ${collectionAddress}: ${err}`);
      return null;
    }
  }

  /**
   * Get NFTs owned by a holder (for collection discovery)
   */
  async getHolderNFTs(
    chain: string,
    holderAddress: string,
    limit: number = 50
  ): Promise<Array<{ chain: string; contractAddress: string }>> {
    if (chain === 'solana') {
      return this.getSolanaNFTs(holderAddress, limit);
    } else {
      return this.getEvmNFTs(chain as Chain, holderAddress, limit);
    }
  }

  private async getEvmNFTs(
    chain: Chain,
    holderAddress: string,
    limit: number
  ): Promise<Array<{ chain: string; contractAddress: string }>> {
    const alchemyKey = this.config.get<string>('ALCHEMY_API_KEY');
    if (!alchemyKey) return [];

    const meta = CHAIN_META[chain];
    if (!meta?.alchemySubdomain) return [];

    try {
      const response = await fetch(
        `https://${meta.alchemySubdomain}.g.alchemy.com/nft/v3/${alchemyKey}/getNFTsForOwner?owner=${holderAddress}&withMetadata=false&pageSize=${limit}`,
        { method: 'GET' }
      );

      if (!response.ok) return [];

      const data = await response.json();
      const contracts = new Set<string>();

      data.ownedNfts?.forEach((nft: any) => {
        if (nft.contract?.address) {
          contracts.add(nft.contract.address.toLowerCase());
        }
      });

      return Array.from(contracts).map(address => ({
        chain,
        contractAddress: address,
      }));
    } catch (err: any) {
      this.logger.error(`Failed to fetch EVM NFTs for ${holderAddress}: ${err?.message || 'unknown error'}`);
      return [];
    }
  }

  private async getSolanaNFTs(
    holderAddress: string,
    limit: number
  ): Promise<Array<{ chain: string; contractAddress: string }>> {
    const heliusKey = this.config.get<string>('HELIUS_API_KEY');
    if (!heliusKey) return [];

    try {
      const response = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'discover',
            method: 'getAssetsByOwner',
            params: {
              ownerAddress: holderAddress,
              page: 1,
              limit,
            },
          }),
        }
      );

      if (!response.ok) return [];

      const data = await response.json();
      const contracts = new Set<string>();

      data.result?.items?.forEach((item: any) => {
        // ONLY add items with explicit 'collection' grouping
        const collectionGroup = item.grouping?.find((g: any) => g.group_key === 'collection');
        
        if (collectionGroup?.group_value) {
          contracts.add(collectionGroup.group_value);
        }
        // Note: We intentionally skip items without collection grouping.
        // These are individual NFT mints, not collections.
      });

      return Array.from(contracts).map(address => ({
        chain: 'solana',
        contractAddress: address,
      }));
    } catch (err: any) {
      this.logger.error(`Failed to fetch Solana NFTs for ${holderAddress}: ${err?.message || 'unknown error'}`);
      return [];
    }
  }

  /**
   * Get contract metadata (for newly discovered contracts)
   */
  async getContractMetadata(chain: string, contractAddress: string) {
    const result = await this.lookupOnChain(contractAddress, chain as Chain);
    return result || null;
  }
}

interface AlchemyContractMetadata{
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
      files?: { uri?: string }[];
    };
    supply?: { print_max_supply?: number };
    authorities?: { address: string }[];
    grouping?: Array<{ group_key: string; group_value: string }>;
  };
}
