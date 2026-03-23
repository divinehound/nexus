export interface CollectionOverlapDto {
  collectionA: {
    id: string;
    name: string;
    chain: string;
    imageUrl: string | null;
  };
  collectionB: {
    id: string;
    name: string;
    chain: string;
    imageUrl: string | null;
  };
  sharedHolders: number;
  totalHoldersA: number;
  totalHoldersB: number;
  overlapPercentageA: number; // % of A's holders who also hold B
  overlapPercentageB: number; // % of B's holders who also hold A
}

export interface NetworkGraphDto {
  nodes: Array<{
    id: string;
    name: string;
    chain: string;
    imageUrl: string | null;
    holderCount: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    sharedHolders: number;
    weight: number; // Normalized overlap strength (0-1)
  }>;
}

export interface RecommendationDto {
  collection: {
    id: string;
    name: string;
    chain: string;
    contractAddress: string;
    imageUrl: string | null;
    holderCount: number;
    floorPrice: number | null;
  };
  score: number; // Recommendation strength (0-1)
  sharedHolders: number;
  basedOn: Array<{
    // Collections user already holds
    id: string;
    name: string;
    overlap: number;
  }>;
  reason: string; // Human-readable explanation
}
