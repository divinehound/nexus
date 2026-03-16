export enum ActivityType {
  SALE = 'sale',
  NOTABLE_SALE = 'notable_sale',
  WHALE_MOVE = 'whale_move',
  MILESTONE = 'milestone',
  FLEX = 'flex',
}

export interface ActivityFeedItem {
  id: string;
  projectId: string;
  activityType: ActivityType;
  walletAddress: string | null;
  collectionId: string | null;
  tokenId: string | null;
  price: number | null;
  message: string | null;
  imageUrl: string | null;
  createdAt: Date;
}

export interface FlexReaction {
  id: string;
  activityId: string;
  walletAddress: string;
  createdAt: Date;
}
