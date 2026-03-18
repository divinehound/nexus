export enum Chain {
  ETHEREUM = 'ethereum',
  BASE = 'base',
  ABSTRACT = 'abstract',
  APECHAIN = 'apechain',
  POLYGON = 'polygon',
  SOLANA = 'solana',
}

export type ChainId = `${Chain}`;

/** All EVM-compatible chains */
export const EVM_CHAINS: Chain[] = [
  Chain.ETHEREUM,
  Chain.BASE,
  Chain.ABSTRACT,
  Chain.APECHAIN,
  Chain.POLYGON,
];

export function isEvmChain(chain: string): boolean {
  return EVM_CHAINS.includes(chain as Chain);
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface Timestamps {
  createdAt: Date;
  updatedAt?: Date;
}

/** Check if a string looks like an EVM contract address (0x + 40 hex chars) */
export function isEvmAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

/** Check if a string looks like a Solana address (base58, 32-44 chars) */
export function isSolanaAddress(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

/** Check if a string looks like any supported contract address */
export function isContractAddress(s: string): boolean {
  return isEvmAddress(s) || isSolanaAddress(s);
}

/** On-chain contract metadata returned from blockchain lookup */
export interface BlockchainContractInfo {
  contractAddress: string;
  chain: string;
  name: string;
  symbol: string;
  totalSupply: number | null;
  tokenType: 'erc721' | 'erc1155' | 'spl';
  imageUrl: string | null;
  deployerAddress: string | null;
}
