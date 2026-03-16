export interface MarketSnapshot {
  collectionId: string;
  timestamp: Date;
  floorPrice: number | null;
  volume24h: number | null;
  holderCount: number | null;
  listedCount: number | null;
}
