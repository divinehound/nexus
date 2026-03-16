import { Chain } from './common';

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  bannerUrl: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
  twitterId: string | null;
  discordUrl: string | null;
  telegramUrl: string | null;
  deployerAddresses: string[];
  healthScore: number | null;
  clusterId: string | null;
  isVerified: boolean;
  createdAt: Date;
}

export enum CollectionType {
  ERC721 = 'erc721',
  ERC1155 = 'erc1155',
  SPL = 'spl',
}

export interface Collection {
  id: string;
  projectId: string;
  contractAddress: string;
  chain: Chain;
  name: string;
  imageUrl: string | null;
  supply: number | null;
  mintDate: Date | null;
  floorPrice: number | null;
  holderCount: number | null;
  listedCount: number | null;
  collectionType: CollectionType;
}

export interface ProjectWiki {
  id: string;
  projectId: string;
  descriptionMd: string | null;
  autoTimeline: Record<string, unknown>[];
  lastEditedBy: string | null;
  lastEditedAt: Date | null;
  revisionNumber: number;
}

export enum WikiSuggestionStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export interface WikiSuggestion {
  id: string;
  projectId: string;
  submittedBy: string;
  field: string;
  proposedValue: string;
  status: WikiSuggestionStatus;
  createdAt: Date;
}
