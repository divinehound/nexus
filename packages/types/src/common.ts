export enum Chain {
  ETHEREUM = 'ethereum',
  SOLANA = 'solana',
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
