import { Logger } from '@nestjs/common';
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
/** DAS getAssetBatch ids per request — small, so one bad batch doesn't lose everyone's metadata. */
const DAS_BATCH = 100;

export interface HeliusEnhancedTx {
  signature: string;
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
  return { movements, fee };
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
  async fetchTxs(address: string, signatures: string[], assets: Map<string, LedgerAsset>): Promise<ChainFetchResult> {
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
    return this.process(address, txs, false, [], assets);
  }

  private async process(
    address: string,
    txs: HeliusEnhancedTx[],
    truncated: boolean,
    notes: string[],
    assets: Map<string, LedgerAsset>,
  ): Promise<ChainFetchResult> {

    const mints = new Set<string>();
    for (const tx of txs) {
      for (const t of tx.tokenTransfers ?? []) if (t.mint && !knownAsset('solana', t.mint)) mints.add(t.mint);
      for (const n of tx.events?.nft?.nfts ?? []) if (n.mint) mints.add(n.mint);
    }
    const dasStats = { dasRequested: 0, dasResolved: 0, dasFailedBatches: 0 };
    const mintInfo = await this.fetchMintInfo([...mints], dasStats);

    const movements: LedgerMovement[] = [];
    const fees: LedgerFee[] = [];
    for (const tx of txs) {
      const r = normalizeSolanaTx(address, tx, mintInfo, assets);
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
