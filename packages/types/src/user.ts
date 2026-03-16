import { Chain } from './common';

export interface User {
  id: string;
  primaryWalletId: string | null;
  echoScore: number | null;
  clusterIds: string[];
  createdAt: Date;
  lastActiveAt: Date | null;
}

export interface Wallet {
  id: string;
  address: string;
  chain: Chain;
  userId: string | null;
  ensName: string | null;
  snsName: string | null;
  lastSyncedAt: Date | null;
}

export interface Holder {
  id: string;
  walletAddress: string;
  collectionId: string;
  chain: Chain;
  firstAcquiredAt: Date;
  quantity: number;
  isCurrent: boolean;
}
