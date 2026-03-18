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
