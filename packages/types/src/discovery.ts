export interface ProjectAffinity {
  projectAId: string;
  projectBId: string;
  overlapCount: number;
  overlapPct: number;
  lastComputedAt: Date;
}

export interface CollectionAffinity {
  collectionAId: string;
  collectionBId: string;
  overlapCount: number;
  overlapPct: number;
  lastComputedAt: Date;
}

export interface WalletAffinity {
  walletAId: string;
  walletBId: string;
  sharedProjects: number;
  affinityScore: number;
  lastComputedAt: Date;
}

export interface Cluster {
  id: string;
  name: string;
  color: string;
  projectCount: number;
  holderCount: number;
  lastComputedAt: Date;
}
