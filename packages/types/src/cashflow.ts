/**
 * Personal crypto cash-flow dashboard ("Mint for crypto") response shapes.
 *
 * All money figures are USD, valued at the daily rate of the asset that
 * actually moved (native coin, wrapped native, or a USD stablecoin). NFTs and
 * other tokens are valued by what was paid or received for them in the same
 * transaction.
 */

/** Where money went (out) or came from (in). */
export type CashflowCategory =
  | 'nft_purchase'
  | 'nft_mint'
  | 'token_purchase'
  | 'transfer_out'
  | 'gas_fees'
  | 'nft_sale'
  | 'token_sale'
  | 'transfer_in';

export type CashflowTxType =
  | 'nft_purchase'
  | 'nft_mint'
  | 'nft_sale'
  | 'token_purchase'
  | 'token_sale'
  | 'swap'
  | 'transfer_out'
  | 'transfer_in'
  | 'received_asset'
  | 'sent_asset'
  | 'own_wallet_transfer'
  | 'bridge'
  | 'contract_interaction';

export interface CashflowTotals {
  inUsd: number;
  outUsd: number;
  netUsd: number;
  feesUsd: number;
  realizedPnlUsd: number;
  /** Cost basis of NFTs/tokens still held (bought within the scanned history). */
  openCostBasisUsd: number;
  txCount: number;
  /** Movements whose USD value could not be determined (no price for the day). */
  unpricedMovements: number;
}

export interface CashflowMonth {
  /** 'YYYY-MM' (UTC) */
  month: string;
  inUsd: number;
  outUsd: number;
  feesUsd: number;
  realizedPnlUsd: number;
  byCategory: Partial<Record<CashflowCategory, number>>;
}

export interface CashflowPosition {
  /** Stable key: chain:contract (or chain:collection for Solana NFTs). */
  key: string;
  chain: string;
  kind: 'nft' | 'fungible';
  contract: string;
  name: string;
  symbol: string | null;
  buyCount: number;
  sellCount: number;
  /** Units acquired / disposed (NFT count, or token amount). */
  qtyBought: number;
  qtySold: number;
  qtyHeld: number;
  spentUsd: number;
  proceedsUsd: number;
  /** Proceeds minus the cost basis of what was sold. */
  realizedPnlUsd: number;
  /** Cost basis of units still held. */
  openCostBasisUsd: number;
  /** Units sold whose purchase was not seen (airdrop, gift, pre-history) — basis taken as $0. */
  qtySoldWithoutBasis: number;
  firstAt: string;
  lastAt: string;
}

export interface CashflowCounterparty {
  chain: string;
  address: string;
  sentUsd: number;
  receivedUsd: number;
  sentCount: number;
  receivedCount: number;
  lastAt: string;
}

export interface CashflowChainFees {
  chain: string;
  symbol: string;
  feesNative: number;
  feesUsd: number;
  txCount: number;
}

export interface CashflowActivityLeg {
  direction: 'in' | 'out';
  name: string;
  symbol: string | null;
  kind: 'native' | 'fungible' | 'nft';
  amount: number;
  tokenId: string | null;
  usd: number | null;
}

export interface CashflowActivity {
  chain: string;
  txHash: string;
  timestamp: string;
  wallet: string;
  type: CashflowTxType;
  label: string;
  inUsd: number;
  outUsd: number;
  feeUsd: number;
  realizedPnlUsd: number | null;
  counterparty: string | null;
  legs: CashflowActivityLeg[];
}

export interface CashflowWalletCoverage {
  chain: string;
  address: string;
  transfers: number;
  truncated: boolean;
  error: string | null;
}

export interface CashflowReport {
  generatedAt: string;
  wallets: Array<{ chain: string; address: string }>;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
  totals: CashflowTotals;
  outByCategory: Partial<Record<CashflowCategory, number>>;
  inByCategory: Partial<Record<CashflowCategory, number>>;
  months: CashflowMonth[];
  collections: CashflowPosition[];
  tokens: CashflowPosition[];
  counterparties: CashflowCounterparty[];
  fees: CashflowChainFees[];
  /** Same-chain moves between linked wallets — excluded from in/out. */
  ownWalletTransfers: { count: number; usd: number };
  /** Cross-chain moves between linked wallets — excluded from in/out; the amount lost in transit counts as a fee. */
  bridges: { count: number; usd: number; feesUsd: number };
  /** Most recent classified transactions, newest first (capped). */
  activity: CashflowActivity[];
  coverage: CashflowWalletCoverage[];
  notes: string[];
}

export type CashflowResponse =
  | { status: 'computing'; startedAt: string; progress: string; previous: CashflowReport | null }
  | { status: 'ready'; report: CashflowReport }
  | { status: 'failed'; error: string; previous: CashflowReport | null }
  | { status: 'no_wallets' };
