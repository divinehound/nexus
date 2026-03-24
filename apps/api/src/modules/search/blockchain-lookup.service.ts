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
   * First tries getAssetsByGroup to get collection info,
   * falls back to getAsset for single mint lookup.
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
      // Try searchAssets first (works with both old and new collection standards)
      const searchRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'searchAssets',
          params: {
            grouping: ['collection', collectionAddress],
            page: 1,
            limit: 1,
          },
        }),
      });

      this.logger.log(`[Solana Lookup] Checking collection ${collectionAddress} via searchAssets`);

      if (searchRes.ok) {
        const searchBody = await searchRes.json();
        const items = searchBody.result?.items;
        const total = searchBody.result?.total;
        
        this.logger.log(`[Solana Lookup] searchAssets response: ${items?.length || 0} items, total: ${total || 'null'}`);
        
        if (items && items.length > 0 && total && total > 1) {
          const firstItem = items[0];
          
          // Try to get collection name from grouping metadata, fallback to deriving from NFT name
          const collectionGroup = firstItem.grouping?.find((g: any) => g.group_key === 'collection');
          let collectionName = firstItem.content?.metadata?.name || '';
          
          // If the name looks like "Collection Name #1234", extract just "Collection Name"
          const numberSuffixMatch = collectionName.match(/^(.+?)\s*#\d+$/);
          if (numberSuffixMatch) {
            collectionName = numberSuffixMatch[1].trim();
          }
          
          this.logger.log(`[Solana Lookup] Collection ${collectionAddress}: found ${total} total items via searchAssets, derived name: ${collectionName}`);
          
          return {
            contractAddress: collectionAddress,
            chain: Chain.SOLANA,
            name: collectionName || `solana:${collectionAddress.slice(0, 8)}`,
            symbol: firstItem.content?.metadata?.symbol || '',
            totalSupply: total,
            tokenType: 'spl',
            imageUrl: firstItem.content?.links?.image || firstItem.content?.files?.[0]?.uri || null,
            deployerAddress: firstItem.authorities?.[0]?.address || null,
          };
        }
      }

      // Try getAssetsByGroup as fallback (for certified collections)
      const groupRes = await fetch(url, {
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

      this.logger.log(`[Solana Lookup] Trying getAssetsByGroup as fallback`);

      if (groupRes.ok) {
        const groupBody = await groupRes.json();
        const items = groupBody.result?.items;
        const total = groupBody.result?.total;
        
        this.logger.log(`[Solana Lookup] getAssetsByGroup response: ${items?.length || 0} items, total: ${total || 'null'}`);
        
        if (items && items.length > 0) {
          const firstItem = items[0];
          const collectionInfo = firstItem.grouping?.find((g: any) => g.group_key === 'collection');
          
          // Derive collection name from first NFT, removing #number suffix
          let collectionName = firstItem.content?.metadata?.name || '';
          const numberSuffixMatch = collectionName.match(/^(.+?)\s*#\d+$/);
          if (numberSuffixMatch) {
            collectionName = numberSuffixMatch[1].trim();
          }
          
          this.logger.log(`[Solana Lookup] Collection ${collectionAddress}: found ${total || 'unknown'} total items, derived name: ${collectionName}`);
          
          // Use collection metadata from first item
          return {
            contractAddress: collectionAddress,
            chain: Chain.SOLANA,
            name: collectionName || `solana:${collectionAddress.slice(0, 8)}`,
            symbol: firstItem.content?.metadata?.symbol || '',
            totalSupply: total || null, // Use the total count from getAssetsByGroup
            tokenType: 'spl',
            imageUrl: firstItem.content?.links?.image || firstItem.content?.files?.[0]?.uri || null,
            deployerAddress: firstItem.authorities?.[0]?.address || null,
          };
        } else {
          this.logger.warn(`[Solana Lookup] getAssetsByGroup returned no items for ${collectionAddress}`);
        }
      } else {
        this.logger.warn(`[Solana Lookup] getAssetsByGroup failed with status ${groupRes.status}`);
      }

      // Fall back to getAsset (treats address as single mint)
      this.logger.log(`[Solana Lookup] Falling back to getAsset for ${collectionAddress}`);
      
      const assetRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAsset',
          params: { id: collectionAddress },
        }),
      });

      if (!assetRes.ok) {
        this.logger.warn(`[Solana Lookup] getAsset failed with status ${assetRes.status}`);
        return null;
      }

      const assetBody = (await assetRes.json()) as HeliusGetAssetResponse;
      const asset = assetBody.result;
      if (!asset) {
        this.logger.warn(`[Solana Lookup] getAsset returned no result for ${collectionAddress}`);
        return null;
      }

      // If this is part of a collection, try to get collection name
      const collectionGroup = asset.grouping?.find((g: any) => g.group_key === 'collection');
      const collectionMint = collectionGroup?.group_value;
      const supply = asset.supply?.print_max_supply ?? null;
      
      this.logger.log(`[Solana Lookup] getAsset fallback: name=${asset.content?.metadata?.name}, supply=${supply}, is part of collection=${!!collectionGroup}`);
      
      if (collectionGroup?.group_value) {
        this.logger.warn(`[Solana Lookup] Address ${collectionAddress} is an NFT mint, not a collection. The collection address is: ${collectionGroup.group_value}. Use that address instead for accurate supply.`);
      }

      return {
        contractAddress: collectionAddress,
        chain: Chain.SOLANA,
        name: asset.content?.metadata?.name || `solana:${collectionAddress.slice(0, 8)}`,
        symbol: asset.content?.metadata?.symbol || '',
        totalSupply: supply,
        tokenType: 'spl',
        imageUrl: asset.content?.links?.image || asset.content?.files?.[0]?.uri || null,
        deployerAddress: asset.authorities?.[0]?.address ?? null,
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
        // Look for 'collection' grouping specifically (not just first grouping)
        const collectionGroup = item.grouping?.find((g: any) => g.group_key === 'collection');
        
        if (collectionGroup?.group_value) {
          contracts.add(collectionGroup.group_value);
        } else if (item.id) {
          // Fallback: if no collection grouping, this is an individual mint
          // We'll skip these to avoid treating mints as collections
          this.logger.debug(`Skipping ungrouped Solana NFT: ${item.id}`);
        }
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
