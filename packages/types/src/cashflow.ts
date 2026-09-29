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
  | 'contract_interaction'
  /** The money half of a trade whose NFTs/tokens moved in a separate tx (cross-chain mint, OTC deal). */
  | 'trade_payment';

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
  /** realizedPnlNative minus that gas, in the chain's own coin. */
  realizedPnlAfterGasNative: number;
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
  /** Buys/sales that moved money on a day with no USD price: counted in the coin, left out of USD totals. */
  usdPriceMissing: number;
  /** Sales with a known USD result; when 0 but sellCount > 0, USD P/L is unknown rather than zero. */
  sellCountUsd: number;
  firstAt: string;
  lastAt: string;
  /** NFTs only: one row per token held — or per round trip, if bought and sold more than once. Newest first. */
  items: CashflowNftItem[];
  /** Tokens only: every buy, sale and other move of this token. Newest first. */
  trades: CashflowTokenTrade[];
}

export type CashflowTokenTradeKind =
  | 'buy'
  | 'sell'
  | 'received'
  | 'sent'
  | 'burned'
  | 'swap_in'
  | 'swap_out'
  /** Sent away and gone for good (marked lost): its cost is a realized loss. */
  | 'lost'
  /** One-wallet view: moved to or from another of your wallets, cost basis carried along. */
  | 'moved_in'
  | 'moved_out';

/** One buy, sale or move of a fungible token. */
export interface CashflowTokenTrade {
  txHash: string;
  at: string;
  kind: CashflowTokenTradeKind;
  qty: number;
  /**
   * What was paid (buys; for swaps in, the cost carried over) or received
   * (sales). null when the day has no USD price; 0 for plain moves.
   */
  usd: number | null;
  native: number | null;
  /** Average cost of the units sold/sent (average-cost basis). */
  costBasisUsd: number | null;
  /** Sales and valued swaps. */
  pnlUsd: number | null;
  pnlNative: number | null;
  gasUsd: number;
  /**
   * Units that left with no recorded purchase (airdrop, gift, a buy the scan
   * missed or older than its history) — counted at $0 cost.
   */
  qtyWithoutBasis?: number;
}

/** 'moved': one-wallet view only — came from / went to another of your wallets. */
export type CashflowNftAcquiredVia =
  | 'purchase'
  | 'mint'
  | 'free_mint'
  | 'received'
  | 'swap'
  | 'moved'
  | 'unknown';
export type CashflowNftDisposedVia = 'sale' | 'sent' | 'burned' | 'swap' | 'lost' | 'moved';

export interface CashflowNftItem {
  tokenId: string;
  /** Usually 1; ERC-1155 editions can be more. */
  qty: number;
  /** null when the purchase wasn't seen (sold something never bought in the scanned history). */
  acquiredAt: string | null;
  acquiredVia: CashflowNftAcquiredVia;
  acquireTxHash: string | null;
  /** null when the acquisition day has no USD price (costNative is still exact for coin payments). */
  costUsd: number | null;
  costNative: number;
  buyGasUsd: number;
  buyGasNative: number;
  /** null while still held. */
  disposedAt: string | null;
  disposedVia: CashflowNftDisposedVia | null;
  disposeTxHash: string | null;
  /** After marketplace fees and royalties; null unless sold. */
  proceedsUsd: number | null;
  proceedsNative: number | null;
  sellGasUsd: number;
  sellGasNative: number;
  /** Sales only. */
  realizedPnlUsd: number | null;
  realizedPnlAfterGasUsd: number | null;
  realizedPnlNative: number | null;
  realizedPnlAfterGasNative: number | null;
  /** The buy or the sale had no USD price for its day, so USD figures are missing (coin figures aren't). */
  usdPriceMissing: boolean;
  holdSeconds: number | null;
  /** One-wallet view: the other wallet of yours it came from ('moved' in) or went to ('moved' out). */
  movedFrom?: string;
  movedTo?: string;
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
  /** Your name for whoever is behind this address (an address label), if any. */
  contact: string | null;
  /** Every money transfer with this address, newest first. */
  transfers: CashflowCounterpartyTransfer[];
}

/** One money transfer (ETH/SOL/stablecoin…) to or from another address. */
export interface CashflowCounterpartyTransfer {
  chain: string;
  txHash: string;
  at: string;
  direction: 'in' | 'out';
  amount: number;
  symbol: string | null;
  usd: number;
  /** Counted as a deposit to/withdrawal from your account at this exchange. */
  exchange: string | null;
  /** Who this transfer was with: the transfer's own label, else the address's. */
  contact: string | null;
}

/** Money sent to / received from one person, across every address and exchange they used. */
export interface CashflowContact {
  name: string;
  sentUsd: number;
  receivedUsd: number;
  sentCount: number;
  receivedCount: number;
  lastAt: string;
  addresses: Array<{ chain: string; address: string }>;
}

/** A name on an address (every transfer with it) or on one transfer. */
export interface CashflowContactLabel {
  id: string;
  kind: 'address' | 'tx';
  /** Chain family ('evm' | 'solana') for an address label, the chain for a tx label. */
  scope: string;
  /** The address (EVM lowercased) or tx hash (EVM lowercased). */
  ref: string;
  label: string;
}

/** A link you made that the report couldn't apply, and why. */
export interface CashflowLinkIssue {
  fromChain: string;
  fromTxHash: string;
  toChain: string;
  toTxHash: string;
  /**
   * not_found: a tx isn't in the scanned history of your wallets (in this view);
   * not_a_trade: both were found, but together they aren't a payment + what it
   * paid for (or a sale + its proceeds, or one move between your wallets);
   * already_linked: they fit, but one is already part of another link.
   */
  reason: 'not_found' | 'not_a_trade' | 'already_linked';
  missing?: 'from' | 'to' | 'both';
  /** For not_a_trade: what each side looks like. */
  fromKind?: CashflowTxShape;
  toKind?: CashflowTxShape;
}

export type CashflowTxShape =
  | 'payment'
  | 'receipt'
  | 'money_both_ways'
  | 'arrival'
  | 'departure'
  | 'swap'
  | 'trade'
  | 'nothing';

/** A token or collection left out of the report: spam by its name, or hidden by you. */
export interface CashflowHiddenAsset {
  /** `chain:contract` (EVM lowercased; Solana mint or collection). */
  key: string;
  chain: string;
  kind: 'nft' | 'fungible';
  name: string;
  symbol: string | null;
  /** flagged = NEXUS marked the collection spam; spam = its name looks like spam; hidden = you hid it. */
  reason: 'flagged' | 'spam' | 'hidden';
}

/** Your own note on a transaction. */
export interface CashflowTxNote {
  id: string;
  chain: string;
  /** EVM hashes lowercased. */
  txHash: string;
  note: string;
  updatedAt: string;
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
  /** Reconstructed from the wallet's balance change (the transfer index didn't show it). */
  inferred: boolean;
  /** The other side of this leg ('' = mint/burn). */
  counterparty: string;
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
  /** Every tx on the other side of a trade when there's more than one (linkedTo is the first). */
  linkedTxs?: Array<{ chain: string; txHash: string }>;
  linkSource: CashflowLinkSource | null;
  /** You marked what this sent away as lost for good; its cost is a realized loss. */
  lost?: boolean;
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
  /** What the scanner found, for diagnosing gaps (e.g. nftLegs, tokenLegs, eventNfts, probes, inferred). */
  stats?: Record<string, number>;
  /** When this wallet+chain was last scanned (scans are saved; page loads don't rescan). */
  scannedAt?: string | null;
  /** The network isn't enabled on the Alchemy app, so it couldn't be scanned. */
  disabled?: boolean;
}

/** Which chains are scanned for one linked address. */
export interface CashflowWalletChains {
  address: string;
  family: 'evm' | 'solana';
  chains: string[];
  /** false = the default (every supported EVM chain). */
  custom: boolean;
}

/** A transaction the user marked as read wrong or missing. */
export interface CashflowFlag {
  id: string;
  chain: string;
  txHash: string;
  note: string | null;
  createdAt: string;
  /** Last time just this transaction was re-read from the chain. */
  reimportedAt: string | null;
}

export interface CashflowReport {
  generatedAt: string;
  /** Set when the report covers only one linked wallet (?wallet=…). */
  walletFilter: string | null;
  /** Set when the report covers only one chain (?chain=…). */
  chainFilter: string | null;
  /** Chains scanned per linked address, and the EVM chains that can be chosen. */
  walletChains: CashflowWalletChains[];
  availableChains: string[];
  /** Every saved wallet+chain scan, whatever the wallet/chain filter (coverage is filtered). */
  scans: CashflowWalletCoverage[];
  flags: CashflowFlag[];
  /** Linked wallets; `watchOnly` = added without verifying (counted here, never used to sign in). */
  wallets: Array<{ chain: string; address: string; watchOnly?: boolean }>;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
  totals: CashflowTotals;
  outByCategory: Partial<Record<CashflowCategory, number>>;
  inByCategory: Partial<Record<CashflowCategory, number>>;
  months: CashflowMonth[];
  collections: CashflowPosition[];
  tokens: CashflowPosition[];
  counterparties: CashflowCounterparty[];
  /** Totals per person you named, across all their addresses. */
  contacts: CashflowContact[];
  contactLabels: CashflowContactLabel[];
  txNotes: CashflowTxNote[];
  /** Links you made that couldn't be applied. */
  linkIssues: CashflowLinkIssue[];
  /** Tokens/collections left out of the report (spam, or hidden by you). */
  hiddenAssets: CashflowHiddenAsset[];
  /** Keys you marked "not spam" (kept although the name looks like spam). */
  shownAssets: string[];
  /** Things still held that you wrote off as lost (tokenId '' = all of a token). */
  writeOffs: Array<{ id: string; assetKey: string; tokenId: string; lostAt: string }>;
  /** Transactions you marked as lost for good. */
  lostTxs: Array<{ id: string; chain: string; txHash: string }>;
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
  /** Most recent classified transactions, newest first (capped — see activityTotal). */
  activity: CashflowActivity[];
  /** How many transactions were classified in total, before the cap on `activity`. */
  activityTotal: number;
  coverage: CashflowWalletCoverage[];
  notes: string[];
}

export type CashflowResponse =
  | { status: 'computing'; startedAt: string; progress: string; previous: CashflowReport | null }
  | { status: 'ready'; report: CashflowReport }
  | { status: 'failed'; error: string; previous: CashflowReport | null }
  | { status: 'no_wallets' };
