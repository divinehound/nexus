import { Logger } from '@nestjs/common';
import { PublicKey } from '@solana/web3.js';
import { knownAsset } from './base-assets';
import type { LedgerAsset, LedgerFee, LedgerMovement } from './cashflow-ledger';
import type { ChainFetchResult } from './evm-activity.fetcher';
import { shortAddress } from './evm-activity.fetcher';
import { chunk, fetchJsonWithRetry, sleep } from './http';

const LAMPORTS_PER_SOL = 1e9;
const MAX_PAGES = 300; // × 100 transactions — Solana wallets collect a lot of spam
/** Helius NFT event types that move an NFT (bids/listings only move SOL or change state). */
const NFT_MOVE_EVENTS = new Set(['NFT_SALE', 'NFT_MINT', 'COMPRESSED_NFT_MINT', 'COMPRESSED_NFT_TRANSFER', 'TRANSFER']);
/** Event types that come with a price the buyer paid. */
const PRICED_NFT_EVENTS = new Set(['NFT_SALE', 'NFT_MINT', 'COMPRESSED_NFT_MINT']);
/**
 * Marketplace escrow moves: placing/cancelling a bid parks SOL in (or returns
 * it from) the user's own bid escrow; escrow-style listings do the same with
 * the NFT. Neither is buying or selling — that happens when the order fills.
 */
const ESCROW_EVENT = /^(NFT_(GLOBAL_)?BID(_CANCELLED)?|NFT_LISTING|NFT_CANCEL_LISTING)$/;
const NFT_STANDARDS = new Set(['NonFungible', 'ProgrammableNonFungible', 'NonFungibleEdition']);
const FUNGIBLE_INTERFACES = new Set(['FungibleToken', 'FungibleAsset']);
const FUNGIBLE_STANDARDS = new Set(['Fungible', 'FungibleAsset']);
/** Metaplex Core: NFTs that are single program accounts, not SPL tokens, so no token transfer ever shows. */
export const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
/** MplAssetInstruction variant indexes (the first byte of the instruction data). */
const CORE_CREATE_V1 = 0;
const CORE_BURN_V1 = 12;
const CORE_TRANSFER_V1 = 14;
const CORE_CREATE_V2 = 20;
/** DAS getAssetBatch ids per request — small, so one bad batch doesn't lose everyone's metadata. */
const DAS_BATCH = 100;

/** One instruction as Helius returns it: account addresses and base58 data. */
export interface HeliusInstruction {
  programId?: string;
  accounts?: string[];
  data?: string;
  innerInstructions?: HeliusInstruction[];
}

export interface HeliusEnhancedTx {
  signature: string;
  instructions?: HeliusInstruction[];
  timestamp: number;
  fee?: number;
  feePayer?: string;
  transactionError?: unknown;
  nativeTransfers?: Array<{ fromUserAccount?: string | null; toUserAccount?: string | null; amount?: number }>;
  tokenTransfers?: Array<{
    fromUserAccount?: string | null;
    toUserAccount?: string | null;
    tokenAmount?: number;
    mint?: string;
    tokenStandard?: string;
    decimals?: number;
  }>;
  /** Helius classification, e.g. NFT_SALE, NFT_BID, SWAP. */
  type?: string;
  source?: string;
  events?: {
    /** Marketplace/mint events, including compressed NFTs and assets that never appear in tokenTransfers. */
    nft?: {
      type?: string;
      /** Price for the whole event, in lamports. */
      amount?: number;
      buyer?: string;
      seller?: string;
      source?: string;
      nfts?: Array<{ mint?: string; tokenStandard?: string }>;
    };
  };
}

export interface MintInfo {
  /** null when DAS didn't say — fall back to the transfer's token standard. */
  isNft: boolean | null;
  name: string | null;
  symbol: string | null;
  /** Verified collection address for NFTs, used to group positions. */
  collection: string | null;
  collectionName: string | null;
}

export const SOL_ASSET_KEY = 'solana:native';

/** Pull the signature Helius suggests resuming from out of an error message, if any. */
export function heliusResumeSignature(message: string): string | null {
  const m = /before(?:-signature)?`?\s*(?:parameter\s*)?(?:set\s*to|=)\s*`?([1-9A-HJ-NP-Za-km-z]{64,90})/i.exec(message);
  return m ? m[1] : null;
}

function solAsset(assets: Map<string, LedgerAsset>): LedgerAsset {
  let a = assets.get(SOL_ASSET_KEY);
  if (!a) {
    a = { key: SOL_ASSET_KEY, chain: 'solana', kind: 'native', contract: '', name: 'Solana', symbol: 'SOL', price: { kind: 'native', symbol: 'SOL' } };
    assets.set(SOL_ASSET_KEY, a);
  }
  return a;
}

export function solanaTokenAsset(
  mint: string,
  standard: string | undefined,
  info: MintInfo | undefined,
  assets: Map<string, LedgerAsset>,
  /** From the transfer itself: a single, indivisible unit (amount 1, 0 decimals). */
  singleUnit = false,
): LedgerAsset {
  const known = knownAsset('solana', mint);
  // Prefer DAS; then the transfer's token standard; if neither says, a lone
  // indivisible unit of a token not marked fungible is an NFT.
  const isNft =
    !known &&
    (info?.isNft ??
      (NFT_STANDARDS.has(standard ?? '') || (singleUnit && !FUNGIBLE_STANDARDS.has(standard ?? ''))));
  const groupAddress = isNft && info?.collection ? info.collection : mint;
  const key = `solana:${groupAddress}`;
  const existing = assets.get(key);
  if (existing) return existing;
  let asset: LedgerAsset;
  if (isNft) {
    const name = info?.collectionName ?? stripEditionNumber(info?.name) ?? shortAddress(groupAddress);
    asset = { key, chain: 'solana', kind: 'nft', contract: groupAddress, name, symbol: info?.symbol ?? null, price: null };
  } else {
    const symbol = known?.symbol ?? info?.symbol ?? null;
    asset = { key, chain: 'solana', kind: 'fungible', contract: mint, name: info?.name ?? symbol ?? shortAddress(mint), symbol, price: known?.price ?? null };
  }
  assets.set(key, asset);
  return asset;
}

function stripEditionNumber(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.replace(/\s*#\s*\d+$/, '').trim() || null;
}

/** Convert one Helius enhanced transaction into movements + fee from `wallet`'s side. */
export function normalizeSolanaTx(
  wallet: string,
  tx: HeliusEnhancedTx,
  mintInfo: Map<string, MintInfo>,
  assets: Map<string, LedgerAsset>,
  /** Core assets the wallet holds going into this tx (updated in place) — see coreAssetMoves. */
  coreHeld: Set<string> = new Set(),
): { movements: LedgerMovement[]; fee: LedgerFee | null } {
  const timestamp = new Date(tx.timestamp * 1000);
  const fee: LedgerFee | null =
    tx.feePayer === wallet && tx.fee
      ? { chain: 'solana', txHash: tx.signature, wallet, timestamp, feeNative: tx.fee / LAMPORTS_PER_SOL, symbol: 'SOL' }
      : null;
  // Failed transactions still cost the fee but move nothing.
  if (tx.transactionError) return { movements: [], fee };

  const movements: LedgerMovement[] = [];
  const base = { chain: 'solana', txHash: tx.signature, timestamp, wallet };
  const nftEvent = tx.events?.nft;
  const eventType = nftEvent?.type ?? tx.type ?? '';
  // SOL moving into or out of the user's own marketplace bid escrow is their
  // money changing pockets, not spending — record it as an own-wallet move
  // (the filled bid is charged when the NFT arrives, below).
  const escrowMove = ESCROW_EVENT.test(eventType);
  let nativeOut = 0;
  let nativeIn = 0;
  for (const n of tx.nativeTransfers ?? []) {
    const from = n.fromUserAccount ?? '';
    const to = n.toUserAccount ?? '';
    if ((from === wallet) === (to === wallet) || !n.amount) continue;
    const direction = from === wallet ? 'out' : 'in';
    const amount = n.amount / LAMPORTS_PER_SOL;
    if (direction === 'out') nativeOut += amount;
    else nativeIn += amount;
    movements.push({
      ...base,
      direction,
      asset: solAsset(assets),
      tokenId: null,
      amount,
      counterparty: escrowMove ? wallet : direction === 'out' ? to : from,
    });
  }
  const tokenMints = new Set<string>();
  for (const t of tx.tokenTransfers ?? []) {
    const from = t.fromUserAccount ?? '';
    const to = t.toUserAccount ?? '';
    if ((from === wallet) === (to === wallet) || !t.mint || !t.tokenAmount) continue;
    tokenMints.add(t.mint);
    const direction = from === wallet ? 'out' : 'in';
    const singleUnit = Number(t.tokenAmount) === 1 && (t.decimals === undefined || t.decimals === 0);
    const asset = solanaTokenAsset(t.mint, t.tokenStandard, mintInfo.get(t.mint), assets, singleUnit);
    movements.push({
      ...base,
      direction,
      asset,
      tokenId: asset.kind === 'nft' ? t.mint : null,
      amount: t.tokenAmount,
      // A listed NFT sitting in escrow is still the user's.
      counterparty: escrowMove ? wallet : direction === 'out' ? to : from,
    });
  }

  // Helius' NFT event covers what tokenTransfers can miss: compressed NFTs and
  // Metaplex Core assets (no SPL token moves), and the price of a purchase
  // paid from a bid escrow rather than the wallet itself.
  if (nftEvent && NFT_MOVE_EVENTS.has(eventType) && nftEvent.nfts?.length) {
    const isBuyer = nftEvent.buyer === wallet;
    const isSeller = nftEvent.seller === wallet;
    if (isBuyer !== isSeller) {
      const direction = isBuyer ? 'in' : 'out';
      const counterparty = (isBuyer ? nftEvent.seller : nftEvent.buyer) ?? '';
      for (const nft of nftEvent.nfts) {
        if (!nft.mint || tokenMints.has(nft.mint)) continue;
        tokenMints.add(nft.mint);
        const asset = solanaTokenAsset(nft.mint, nft.tokenStandard ?? 'NonFungible', mintInfo.get(nft.mint), assets);
        movements.push({ ...base, direction, asset, tokenId: asset.kind === 'nft' ? nft.mint : null, amount: 1, counterparty, fromEvent: true });
      }
      const price = (nftEvent.amount ?? 0) / LAMPORTS_PER_SOL;
      if (PRICED_NFT_EVENTS.has(eventType) && price > 0) {
        if (isBuyer && nativeOut < price * 0.9) {
          // Paid (mostly) from somewhere other than the wallet — a bid escrow.
          movements.push({
            ...base,
            direction: 'out',
            asset: solAsset(assets),
            tokenId: null,
            amount: price - nativeOut,
            counterparty: counterparty || 'contract',
            inferred: true,
          });
        } else if (isSeller && nativeIn === 0) {
          // Proceeds went somewhere else first; the event price is the best we have.
          movements.push({
            ...base,
            direction: 'in',
            asset: solAsset(assets),
            tokenId: null,
            amount: price,
            counterparty: counterparty || 'contract',
            inferred: true,
          });
        }
      }
    }
  }
  // Metaplex Core mints/transfers/burns, read from the instructions themselves
  // (Helius often has no event for them, and there's no token transfer).
  for (const move of coreAssetMoves(tx, wallet, coreHeld)) {
    if (tokenMints.has(move.asset)) continue;
    tokenMints.add(move.asset);
    const info = mintInfo.get(move.asset) ?? {
      isNft: true,
      name: null,
      symbol: null,
      collection: move.collection,
      collectionName: null,
    };
    const asset = solanaTokenAsset(move.asset, 'NonFungible', info, assets);
    movements.push({
      ...base,
      direction: move.direction,
      asset,
      tokenId: move.asset,
      amount: 1,
      counterparty: move.counterparty,
      fromCore: true,
    });
  }
  return { movements, fee };
}

export interface CoreAssetMove {
  asset: string;
  collection: string | null;
  direction: 'in' | 'out';
  /** '' for a mint or burn. */
  counterparty: string;
}

/**
 * Metaplex Core asset moves for `wallet` in a tx — top-level or called by
 * another program (a launchpad minting, a marketplace settling a sale).
 * Account layouts follow mpl-core's MplAssetInstruction; an optional account
 * that isn't passed is filled with the program's own id.
 *
 * `held` is the set of Core assets the wallet owns going into the tx (updated
 * in place; walk txs oldest first). A marketplace sale is signed by the
 * marketplace — a transfer delegate or its escrow — so the seller isn't in
 * the transfer's accounts; knowing the wallet held the asset is what makes it
 * the seller's.
 */
export function coreAssetMoves(tx: HeliusEnhancedTx, wallet: string, held: Set<string> = new Set()): CoreAssetMove[] {
  const moves: CoreAssetMove[] = [];
  const visit = (ix: HeliusInstruction) => {
    if (ix.programId === MPL_CORE_PROGRAM && ix.accounts?.length) {
      const move = coreMove(ix.accounts, firstByte(ix.data), wallet, held);
      if (move) moves.push(move);
    }
    for (const inner of ix.innerInstructions ?? []) visit(inner);
  };
  for (const ix of tx.instructions ?? []) visit(ix);
  return moves;
}

function coreMove(accounts: string[], variant: number | null, wallet: string, held: Set<string>): CoreAssetMove | null {
  const opt = (i: number) => {
    const a = accounts[i];
    return a && a !== MPL_CORE_PROGRAM ? a : null;
  };
  const asset = accounts[0];
  const collection = opt(1);
  if (variant === CORE_CREATE_V1 || variant === CORE_CREATE_V2) {
    // asset, collection?, authority?, payer, owner?, update_authority?, …
    // The program makes the owner: owner ?? update_authority ?? payer.
    const owner = opt(4) ?? opt(5) ?? opt(3);
    if (owner !== wallet) return null;
    held.add(asset);
    return { asset, collection, direction: 'in', counterparty: '' };
  }
  if (variant === CORE_TRANSFER_V1) {
    // asset, collection?, payer, authority?, new_owner, …
    // `authority` is the owner or a delegate (e.g. a marketplace); without one, the payer.
    const from = opt(3) ?? opt(2);
    const to = opt(4);
    if (to === wallet) {
      if (from === wallet) return null;
      // Back from a listing escrow: it never stopped being the wallet's.
      if (held.has(asset)) return { asset, collection, direction: 'in', counterparty: wallet };
      held.add(asset);
      return { asset, collection, direction: 'in', counterparty: from ?? '' };
    }
    if (from !== wallet && !held.has(asset)) return null;
    // Into a program's escrow (an off-curve address, e.g. a marketplace
    // listing): the wallet still owns it until it's sold.
    if (to && isProgramAddress(to)) return { asset, collection, direction: 'out', counterparty: wallet };
    held.delete(asset);
    return { asset, collection, direction: 'out', counterparty: to ?? '' };
  }
  if (variant === CORE_BURN_V1) {
    // asset, collection?, payer, authority?, …
    if ((opt(3) ?? opt(2)) !== wallet && !held.has(asset)) return null;
    held.delete(asset);
    return { asset, collection, direction: 'out', counterparty: '' };
  }
  return null;
}

/** A program-derived address (off the ed25519 curve) — an escrow or vault, never a person's wallet. */
export function isProgramAddress(address: string): boolean {
  try {
    return !PublicKey.isOnCurve(new PublicKey(address).toBytes());
  } catch {
    return false;
  }
}

/** Oldest first, so Core ownership can be followed through the history (Helius pages newest first). */
function chronological(txs: HeliusEnhancedTx[]): HeliusEnhancedTx[] {
  return txs
    .map((tx, i) => ({ tx, i }))
    .sort((a, b) => a.tx.timestamp - b.tx.timestamp || b.i - a.i)
    .map((x) => x.tx);
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** First byte of base58-encoded instruction data, or null if it isn't valid base58. */
export function firstByte(data: string | undefined): number | null {
  if (!data) return null;
  let n = 0n;
  for (const ch of data) {
    const v = BASE58.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  let leadingZeros = 0;
  while (leadingZeros < data.length && data[leadingZeros] === '1') leadingZeros++;
  if (leadingZeros > 0) return 0;
  if (n === 0n) return null;
  return Number(n >> BigInt((n.toString(16).length + 1 >> 1) * 8 - 8));
}

/** Full transaction history for one Solana address via Helius' enhanced transactions API. */
export class SolanaActivityFetcher {
  private readonly logger = new Logger(SolanaActivityFetcher.name);

  constructor(private readonly apiKey: string) {}

  async fetch(address: string, assets: Map<string, LedgerAsset>): Promise<ChainFetchResult> {
    const txs: HeliusEnhancedTx[] = [];
    const seen = new Set<string>();
    const notes: string[] = [];
    let before: string | undefined;
    let truncated = true;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`https://api.helius.xyz/v0/addresses/${address}/transactions`);
      url.searchParams.set('api-key', this.apiKey);
      url.searchParams.set('limit', '100');
      // Helius' pagination cursor is `before-signature` (a plain `before` is ignored,
      // which silently returns the newest page over and over).
      if (before) url.searchParams.set('before-signature', before);
      let batch: HeliusEnhancedTx[];
      try {
        batch = await fetchJsonWithRetry<HeliusEnhancedTx[]>(url.toString(), { headers: { accept: 'application/json' } }, 'Helius address transactions');
      } catch (err) {
        // Helius can answer "no events in the search window — continue with before-signature=<sig>".
        const resume = heliusResumeSignature((err as Error).message);
        if (resume && resume !== before) {
          before = resume;
          continue;
        }
        throw err;
      }
      if (!Array.isArray(batch) || batch.length === 0) {
        truncated = false;
        break;
      }
      const fresh = batch.filter((tx) => tx.signature && !seen.has(tx.signature));
      if (fresh.length === 0) {
        // The cursor didn't move — stop rather than re-read the same page.
        this.logger.warn(`Helius pagination stalled for ${address} at ${before}`);
        notes.push(`Solana ${shortAddress(address)}: history paging stopped early; older activity may be missing.`);
        break;
      }
      for (const tx of fresh) seen.add(tx.signature);
      txs.push(...fresh);
      before = batch[batch.length - 1].signature;
      await sleep(150);
    }
    if (truncated) {
      notes.push(`Solana ${shortAddress(address)}: only the newest ${txs.length.toLocaleString()} transactions were scanned.`);
    }
    return this.process(address, txs, truncated, notes, assets);
  }

  /** Re-read only the given transactions for `address` — the re-import of flagged transactions. */
  async fetchTxs(
    address: string,
    signatures: string[],
    assets: Map<string, LedgerAsset>,
    /** NFTs the wallet held per the saved scan, so a marketplace-signed sale is still seen as the wallet's. */
    coreHeld: Set<string> = new Set(),
  ): Promise<ChainFetchResult> {
    const txs: HeliusEnhancedTx[] = [];
    for (const batch of chunk(signatures, 100)) {
      const url = `https://api.helius.xyz/v0/transactions?api-key=${this.apiKey}`;
      const rows = await fetchJsonWithRetry<HeliusEnhancedTx[]>(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactions: batch }) },
        'Helius parse transactions',
      );
      if (Array.isArray(rows)) txs.push(...rows.filter((tx) => tx?.signature));
    }
    return this.process(address, txs, false, [], assets, coreHeld);
  }

  private async process(
    address: string,
    txs: HeliusEnhancedTx[],
    truncated: boolean,
    notes: string[],
    assets: Map<string, LedgerAsset>,
    coreHeld: Set<string> = new Set(),
  ): Promise<ChainFetchResult> {
    txs = chronological(txs);

    const mints = new Set<string>();
    const dasHeld = new Set(coreHeld); // a dry run of the ownership walk below
    for (const tx of txs) {
      for (const t of tx.tokenTransfers ?? []) if (t.mint && !knownAsset('solana', t.mint)) mints.add(t.mint);
      for (const n of tx.events?.nft?.nfts ?? []) if (n.mint) mints.add(n.mint);
      for (const m of coreAssetMoves(tx, address, dasHeld)) mints.add(m.asset);
    }
    const dasStats = { dasRequested: 0, dasResolved: 0, dasFailedBatches: 0 };
    const mintInfo = await this.fetchMintInfo([...mints], dasStats);

    const movements: LedgerMovement[] = [];
    const fees: LedgerFee[] = [];
    for (const tx of txs) {
      const r = normalizeSolanaTx(address, tx, mintInfo, assets, coreHeld);
      movements.push(...r.movements);
      if (r.fee) fees.push(r.fee);
    }
    if (dasStats.dasFailedBatches > 0) {
      notes.push(
        `Solana ${shortAddress(address)}: metadata lookups failed for some items; they may be grouped by mint instead of by collection.`,
      );
    }
    const stats = {
      transactions: txs.length,
      nftLegs: movements.filter((m) => m.asset.kind === 'nft').length,
      tokenLegs: movements.filter((m) => m.asset.kind === 'fungible').length,
      nftsFromEvents: movements.filter((m) => m.fromEvent).length,
      coreNfts: movements.filter((m) => m.fromCore).length,
      escrowPayments: movements.filter((m) => m.inferred).length,
      nftCollections: new Set(movements.filter((m) => m.asset.kind === 'nft').map((m) => m.asset.key)).size,
      ...dasStats,
    };
    return { movements, fees, transfers: txs.length, truncated, notes, stats };
  }

  /** DAS getAssetBatch: token vs NFT, names, and verified collection for grouping. */
  private async fetchMintInfo(
    mints: string[],
    stats: { dasRequested: number; dasResolved: number; dasFailedBatches: number },
  ): Promise<Map<string, MintInfo>> {
    const info = new Map<string, MintInfo>();
    const rpc = `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
    type DasAsset = {
      id: string;
      interface?: string;
      content?: { metadata?: { name?: string; symbol?: string } };
      grouping?: Array<{ group_key?: string; group_value?: string }>;
      token_info?: { symbol?: string };
    };
    const getBatch = async (ids: string[]): Promise<DasAsset[]> => {
      const json = await fetchJsonWithRetry<{ result?: Array<DasAsset | null> }>(
        rpc,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids } }) },
        'Helius getAssetBatch',
      );
      return (json.result ?? []).filter((a): a is DasAsset => !!a);
    };

    // Each batch stands alone: a failed request loses at most DAS_BATCH lookups.
    for (const ids of chunk(mints, DAS_BATCH)) {
      stats.dasRequested += ids.length;
      try {
        for (const a of await getBatch(ids)) {
          const collection = a.grouping?.find((g) => g.group_key === 'collection')?.group_value ?? null;
          info.set(a.id, {
            isNft: a.interface ? !FUNGIBLE_INTERFACES.has(a.interface) : null,
            name: a.content?.metadata?.name?.trim() || null,
            symbol: a.token_info?.symbol || a.content?.metadata?.symbol?.trim() || null,
            collection,
            collectionName: null,
          });
          stats.dasResolved++;
        }
      } catch (err) {
        stats.dasFailedBatches++;
        this.logger.warn(`Solana mint metadata batch failed: ${(err as Error).message}`);
      }
      await sleep(250);
    }
    // Collection names live on the collection's own asset.
    const collections = [...new Set([...info.values()].map((i) => i.collection).filter((c): c is string => !!c))];
    const names = new Map<string, string>();
    for (const ids of chunk(collections, DAS_BATCH)) {
      try {
        for (const a of await getBatch(ids)) {
          const name = a.content?.metadata?.name?.trim();
          if (name) names.set(a.id, name);
        }
      } catch (err) {
        stats.dasFailedBatches++;
        this.logger.warn(`Solana collection name batch failed: ${(err as Error).message}`);
      }
      await sleep(250);
    }
    for (const i of info.values()) if (i.collection) i.collectionName = names.get(i.collection) ?? null;
    return info;
  }
}
