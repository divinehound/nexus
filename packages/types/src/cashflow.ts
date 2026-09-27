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
  | 'exchange_deposit'
  | 'gas_fees'
  | 'nft_sale'
  | 'token_sale'
  | 'transfer_in'
  | 'exchange_withdrawal';

export type CashflowTxType =
  | 'nft_purchase'
  | 'nft_mint'
  | 'nft_sale'
  | 'token_purchase'
  | 'token_sale'
  | 'swap'
  | 'transfer_out'
  | 'transfer_in'
  | 'exchange_deposit'
  | 'exchange_withdrawal'
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
  /** Realized P/L minus the gas paid to buy/mint and to sell what was sold. */
  realizedPnlAfterGasUsd: number;
  /** The part of realized P/L earned in the chain's own coin, valued at the sale-day price. */
  tradeGainUsd: number;
  /** The rest of realized P/L: the coin's own price moving while you held (realized = trade gain + price move). */
  priceMoveUsd: number;
  /** Realized P/L in each chain's own coin, e.g. { ETH: 0.4, SOL: -12 }. */
  realizedPnlNative: Record<string, number>;
  /** Money moved from exchanges into your wallets. */
  onRampUsd: number;
  /** Money moved from your wallets to exchanges. */
  offRampUsd: number;
  /** onRamp − offRamp: how much of your own money is still in crypto. */
  netInvestedUsd: number;
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
  realizedPnlAfterGasUsd: number;
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
  /** Proceeds (after marketplace fees and royalties) minus the cost basis of what was sold. Excludes gas. */
  realizedPnlUsd: number;
  /** realizedPnlUsd minus gas paid to acquire the sold units and gas paid on the sales. */
  realizedPnlAfterGasUsd: number;
  /** All gas paid on transactions involving this asset (buys, mints, sales, swaps, sends). */
  gasUsd: number;
  /** The chain's own coin (ETH, SOL, APE, POL) that native figures are in. */
  nativeSymbol: string;
  spentNative: number;
  proceedsNative: number;
  /** Realized P/L in the native coin: cost converted at the buy-day rate, proceeds at the sale-day rate. */
  realizedPnlNative: number;
  tradeGainUsd: number;
  priceMoveUsd: number;
  /** Cost basis of units still held. */
  openCostBasisUsd: number;
  /** Units sold whose purchase was not seen (airdrop, gift, pre-history) — basis taken as $0. */
  qtySoldWithoutBasis: number;
  firstAt: string;
  lastAt: string;
  /** NFTs only: one row per token held — or per round trip, if bought and sold more than once. Newest first. */
  items: CashflowNftItem[];
}

export type CashflowNftAcquiredVia = 'purchase' | 'mint' | 'free_mint' | 'received' | 'swap' | 'unknown';
export type CashflowNftDisposedVia = 'sale' | 'sent' | 'burned' | 'swap';

export interface CashflowNftItem {
  tokenId: string;
  /** Usually 1; ERC-1155 editions can be more. */
  qty: number;
  /** null when the purchase wasn't seen (sold something never bought in the scanned history). */
  acquiredAt: string | null;
  acquiredVia: CashflowNftAcquiredVia;
  acquireTxHash: string | null;
  costUsd: number;
  costNative: number;
  buyGasUsd: number;
  /** null while still held. */
  disposedAt: string | null;
  disposedVia: CashflowNftDisposedVia | null;
  disposeTxHash: string | null;
  /** After marketplace fees and royalties; null unless sold. */
  proceedsUsd: number | null;
  proceedsNative: number | null;
  sellGasUsd: number;
  /** Sales only. */
  realizedPnlUsd: number | null;
  realizedPnlAfterGasUsd: number | null;
  realizedPnlNative: number | null;
  holdSeconds: number | null;
}

export type CashflowExchangeSource = 'known' | 'detected' | 'tagged';

export interface CashflowCounterparty {
  chain: string;
  address: string;
  /** Set when this address belongs to a centralized exchange. */
  exchange: string | null;
  /** known = exchange's public wallet; detected = your deposit address (sweeps to the exchange); tagged = you marked it. */
  exchangeSource: CashflowExchangeSource | null;
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
  /** Exchange name for exchange deposits/withdrawals. */
  exchange: string | null;
  /** For bridges: the other half of the move, and how the pair was established. */
  linkedTo: { chain: string; txHash: string } | null;
  linkSource: CashflowLinkSource | null;
  /** Whether this row is where the money left ('out') or arrived ('in'). */
  linkSide: 'out' | 'in' | null;
  legs: CashflowActivityLeg[];
}

export type CashflowLinkSource = 'auto' | 'manual' | 'relay';

export interface CashflowExchangeSummary {
  exchange: string;
  /** Sent from your wallets to this exchange (cashed out). */
  depositedUsd: number;
  /** Withdrawn from this exchange into your wallets. */
  withdrawnUsd: number;
  txCount: number;
}

export interface CashflowTxLink {
  id: string;
  kind: 'link' | 'unlink';
  fromChain: string;
  fromTxHash: string;
  toChain: string;
  toTxHash: string;
}

export interface CashflowAddressTag {
  id: string;
  chainFamily: 'evm' | 'solana';
  address: string;
  exchange: string;
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
  exchanges: CashflowExchangeSummary[];
  /** The user's manual link/unlink overrides and exchange tags, echoed for the UI. */
  links: CashflowTxLink[];
  addressTags: CashflowAddressTag[];
  /** Exchange names offered when tagging an address. */
  exchangeNames: string[];
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
