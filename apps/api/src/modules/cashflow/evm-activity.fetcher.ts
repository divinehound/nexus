import { Logger } from '@nestjs/common';
import { knownAsset } from './base-assets';
import type { LedgerAsset, LedgerFee, LedgerMovement } from './cashflow-ledger';
import { chunk, fetchJsonWithRetry, NonRetryableError } from './http';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ALCHEMY_NETWORK: Record<string, string> = {
  ethereum: 'eth-mainnet',
  base: 'base-mainnet',
  polygon: 'polygon-mainnet',
  abstract: 'abstract-mainnet',
  apechain: 'apechain-mainnet',
  // Not tracked elsewhere in the app, but common bridge destinations: scanning
  // them lets bridged money net out instead of looking like spending.
  arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet',
  zora: 'zora-mainnet',
  blast: 'blast-mainnet',
  linea: 'linea-mainnet',
};

export const EVM_NATIVE: Record<string, { symbol: string; name: string }> = {
  ethereum: { symbol: 'ETH', name: 'Ether' },
  base: { symbol: 'ETH', name: 'Ether' },
  abstract: { symbol: 'ETH', name: 'Ether' },
  polygon: { symbol: 'POL', name: 'Polygon' },
  apechain: { symbol: 'APE', name: 'ApeCoin' },
  arbitrum: { symbol: 'ETH', name: 'Ether' },
  optimism: { symbol: 'ETH', name: 'Ether' },
  zora: { symbol: 'ETH', name: 'Ether' },
  blast: { symbol: 'ETH', name: 'Ether' },
  linea: { symbol: 'ETH', name: 'Ether' },
};

export const EVM_CHAINS = Object.keys(ALCHEMY_NETWORK);

/** Alchemy only traces internal (contract → wallet) ETH transfers on these networks. */
const INTERNAL_SUPPORTED = new Set(['ethereum', 'polygon']);

/** Upper bounds that keep one refresh from running for hours on very active wallets. */
const MAX_PAGES_PER_DIRECTION = 30; // × 1000 transfers
const MAX_RECEIPTS = 6000;

export interface AlchemyTransfer {
  blockNum: string;
  uniqueId?: string;
  hash: string;
  from: string;
  to: string | null;
  value: number | null;
  erc721TokenId?: string | null;
  erc1155Metadata?: Array<{ tokenId: string; value: string }> | null;
  tokenId?: string | null;
  asset: string | null;
  category: string;
  rawContract?: { value: string | null; address: string | null; decimal: string | null };
  metadata?: { blockTimestamp?: string };
}

export interface ChainFetchResult {
  movements: LedgerMovement[];
  fees: LedgerFee[];
  transfers: number;
  truncated: boolean;
  notes: string[];
}

/** Resolve (and share) the asset for a transfer so later name enrichment updates every movement. */
export function evmAssetFor(chain: string, t: AlchemyTransfer, assets: Map<string, LedgerAsset>): LedgerAsset {
  const isNative = t.category === 'external' || t.category === 'internal';
  const contract = isNative ? '' : (t.rawContract?.address ?? '').toLowerCase();
  const key = `${chain}:${contract || 'native'}`;
  const existing = assets.get(key);
  if (existing) return existing;

  let asset: LedgerAsset;
  if (isNative) {
    const native = EVM_NATIVE[chain] ?? { symbol: 'ETH', name: 'Ether' };
    asset = { key, chain, kind: 'native', contract: '', name: native.name, symbol: native.symbol, price: { kind: 'native', symbol: native.symbol } };
  } else if (t.category === 'erc20') {
    const known = knownAsset(chain, contract);
    const symbol = known?.symbol ?? t.asset ?? null;
    asset = { key, chain, kind: 'fungible', contract, name: symbol ?? shortAddress(contract), symbol, price: known?.price ?? null };
  } else {
    asset = { key, chain, kind: 'nft', contract, name: t.asset || shortAddress(contract), symbol: null, price: null };
  }
  assets.set(key, asset);
  return asset;
}

function hexToBigInt(hex: string | null | undefined): bigint | null {
  if (!hex) return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

function scaled(raw: bigint, decimals: number): number {
  if (decimals <= 0) return Number(raw);
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

function tokenIdToString(id: string | null | undefined): string | null {
  const n = hexToBigInt(id);
  return n === null ? (id ?? null) : n.toString();
}

/**
 * Convert one Alchemy transfer into ledger movements from `wallet`'s side.
 * ERC-1155 batch transfers expand to one movement per token id.
 */
export function normalizeEvmTransfer(
  chain: string,
  wallet: string,
  t: AlchemyTransfer,
  timestamp: Date,
  assets: Map<string, LedgerAsset>,
): LedgerMovement[] {
  const me = wallet.toLowerCase();
  const from = (t.from ?? '').toLowerCase();
  const to = (t.to ?? '').toLowerCase();
  // from == to == me: a self-send, or (on L2s) a bridge deposit from the same
  // address on L1. Keep it as an arrival from ourselves; the ledger decides
  // which from whether this wallet paid gas for it.
  const direction: 'in' | 'out' = from === me && to !== me ? 'out' : 'in';
  const other = direction === 'out' ? to : from;
  const counterparty = other === ZERO_ADDRESS ? '' : other;
  const asset = evmAssetFor(chain, t, assets);
  const base = { chain, txHash: t.hash, timestamp, wallet: me, direction, asset, counterparty };

  if (t.category === 'erc1155') {
    return (t.erc1155Metadata ?? []).map((m) => ({
      ...base,
      tokenId: tokenIdToString(m.tokenId),
      amount: Number(hexToBigInt(m.value) ?? 1n),
    }));
  }
  if (asset.kind === 'nft') {
    return [{ ...base, tokenId: tokenIdToString(t.erc721TokenId ?? t.tokenId), amount: 1 }];
  }

  let amount: number | null = null;
  const raw = hexToBigInt(t.rawContract?.value);
  const decimals = hexToBigInt(t.rawContract?.decimal);
  if (raw !== null && (decimals !== null || asset.kind === 'native')) {
    amount = scaled(raw, decimals === null ? 18 : Number(decimals));
  } else if (typeof t.value === 'number') {
    amount = t.value;
  }
  if (amount === null || !(amount > 0)) return [];
  return [{ ...base, tokenId: null, amount }];
}

/**
 * Full transfer history for one address on one EVM chain via Alchemy's
 * `alchemy_getAssetTransfers`, plus gas paid for transactions it sent.
 */
export class EvmActivityFetcher {
  private readonly logger = new Logger(EvmActivityFetcher.name);

  constructor(private readonly apiKey: string) {}

  async fetch(chain: string, address: string, assets: Map<string, LedgerAsset>): Promise<ChainFetchResult> {
    const network = ALCHEMY_NETWORK[chain];
    if (!network) throw new Error(`Unsupported EVM chain ${chain}`);
    const endpoint = `https://${network}.g.alchemy.com/v2/${this.apiKey}`;
    const notes: string[] = [];

    const categories = ['external', 'erc20', 'erc721', 'erc1155'];
    if (INTERNAL_SUPPORTED.has(chain)) categories.push('internal');
    if (chain === 'ethereum') categories.push('specialnft');

    const outgoing = await this.pageTransfers(endpoint, chain, { fromAddress: address }, categories);
    const incoming = await this.pageTransfers(endpoint, chain, { toAddress: address }, categories);
    const truncated = outgoing.truncated || incoming.truncated;
    // Self-transfers come back from both queries; keep one copy.
    const seen = new Set<string>();
    const all = [...outgoing.transfers, ...incoming.transfers].filter((t) => {
      const id = t.uniqueId ?? `${t.hash}:${t.category}:${t.rawContract?.address ?? ''}:${t.erc721TokenId ?? t.tokenId ?? ''}:${t.rawContract?.value ?? ''}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // Fill missing block timestamps (some networks, e.g. Abstract, omit them).
    const missingBlocks = [...new Set(all.filter((t) => !t.metadata?.blockTimestamp).map((t) => t.blockNum))];
    const blockTimes = missingBlocks.length > 0 ? await this.fetchBlockTimestamps(endpoint, missingBlocks) : new Map<string, Date>();

    const movements: LedgerMovement[] = [];
    const txTimes = new Map<string, Date>();
    for (const t of all) {
      const ts = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp) : blockTimes.get(t.blockNum);
      if (!ts || Number.isNaN(ts.getTime())) continue;
      txTimes.set(t.hash, ts);
      movements.push(...normalizeEvmTransfer(chain, address, t, ts, assets));
    }

    // Gas: every top-level tx this wallet sent shows up as an outgoing 'external'
    // transfer (zero-value included), so those hashes are the txs it paid for.
    let sentHashes = [...new Set(outgoing.transfers.filter((t) => t.category === 'external').map((t) => t.hash))];
    if (sentHashes.length > MAX_RECEIPTS) {
      notes.push(`${chain} ${shortAddress(address)}: gas counted for the latest ${MAX_RECEIPTS} of ${sentHashes.length} sent transactions.`);
      sentHashes = sentHashes.slice(-MAX_RECEIPTS);
    }
    const fees = await this.fetchFees(endpoint, chain, address, sentHashes, txTimes);

    return { movements, fees, transfers: all.length, truncated, notes };
  }

  private async pageTransfers(
    endpoint: string,
    chain: string,
    filter: { fromAddress?: string; toAddress?: string },
    categories: string[],
  ): Promise<{ transfers: AlchemyTransfer[]; truncated: boolean }> {
    const transfers: AlchemyTransfer[] = [];
    let pageKey: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_DIRECTION; page++) {
      const params: Record<string, unknown> = {
        fromBlock: '0x0',
        toBlock: 'latest',
        ...filter,
        category: categories,
        withMetadata: true,
        excludeZeroValue: false,
        maxCount: '0x3e8',
        order: 'asc',
      };
      if (pageKey) params.pageKey = pageKey;

      const json = await fetchJsonWithRetry<{ result?: { transfers?: AlchemyTransfer[]; pageKey?: string }; error?: { message?: string } }>(
        endpoint,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }) },
        `alchemy_getAssetTransfers (${chain})`,
      );
      if (json.error) {
        const message = json.error.message ?? 'unknown error';
        // Some networks reject categories they don't index; fall back to the core set once.
        if (page === 0 && /categor/i.test(message) && categories.some((c) => c === 'internal' || c === 'specialnft')) {
          this.logger.warn(`${chain}: ${message} — retrying without internal/specialnft`);
          return this.pageTransfers(endpoint, chain, filter, categories.filter((c) => c !== 'internal' && c !== 'specialnft'));
        }
        throw new NonRetryableError(`alchemy_getAssetTransfers (${chain}): ${message}`);
      }
      transfers.push(...(json.result?.transfers ?? []));
      pageKey = json.result?.pageKey;
      if (!pageKey) return { transfers, truncated: false };
    }
    return { transfers, truncated: true };
  }

  private async rpcBatch<T>(endpoint: string, method: string, paramsList: unknown[][], label: string): Promise<Array<T | null>> {
    const payload = paramsList.map((params, id) => ({ jsonrpc: '2.0', id, method, params }));
    const data = await fetchJsonWithRetry<Array<{ id: number; result?: T | null }> | { error?: { message?: string } }>(
      endpoint,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
      label,
    );
    if (!Array.isArray(data)) throw new Error(`${label}: ${data?.error?.message ?? 'non-array batch response'}`);
    const out: Array<T | null> = new Array(paramsList.length).fill(null);
    for (const row of data) {
      if (typeof row.id === 'number' && row.id < out.length) out[row.id] = row.result ?? null;
    }
    return out;
  }

  private async fetchBlockTimestamps(endpoint: string, blocks: string[]): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    for (const batch of chunk(blocks, 100)) {
      const rows = await this.rpcBatch<{ timestamp?: string }>(endpoint, 'eth_getBlockByNumber', batch.map((b) => [b, false]), 'eth_getBlockByNumber batch');
      rows.forEach((row, i) => {
        const ts = hexToBigInt(row?.timestamp);
        if (ts !== null) result.set(batch[i], new Date(Number(ts) * 1000));
      });
    }
    return result;
  }

  private async fetchFees(
    endpoint: string,
    chain: string,
    address: string,
    hashes: string[],
    txTimes: Map<string, Date>,
  ): Promise<LedgerFee[]> {
    const symbol = EVM_NATIVE[chain]?.symbol ?? 'ETH';
    const fees: LedgerFee[] = [];
    type Receipt = { from?: string; gasUsed?: string; effectiveGasPrice?: string; l1Fee?: string };
    for (const batch of chunk(hashes, 100)) {
      const receipts = await this.rpcBatch<Receipt>(endpoint, 'eth_getTransactionReceipt', batch.map((h) => [h]), 'eth_getTransactionReceipt batch');
      receipts.forEach((r, i) => {
        if (!r || (r.from && r.from.toLowerCase() !== address.toLowerCase())) return;
        const gasUsed = hexToBigInt(r.gasUsed) ?? 0n;
        const price = hexToBigInt(r.effectiveGasPrice) ?? 0n;
        // OP-stack L2s (Base) charge an L1 data fee on top of L2 execution gas.
        const l1Fee = hexToBigInt(r.l1Fee) ?? 0n;
        const wei = gasUsed * price + l1Fee;
        const timestamp = txTimes.get(batch[i]);
        if (wei === 0n || !timestamp) return;
        fees.push({ chain, txHash: batch[i], wallet: address.toLowerCase(), timestamp, feeNative: scaled(wei, 18), symbol });
      });
    }
    return fees;
  }

  /**
   * Where `address` most recently sent money — used to spot exchange deposit
   * addresses, which sweep everything they receive into the exchange's wallets.
   */
  async fetchRecentRecipients(chain: string, address: string, limit = 20): Promise<string[]> {
    const network = ALCHEMY_NETWORK[chain];
    if (!network) return [];
    const json = await fetchJsonWithRetry<{ result?: { transfers?: AlchemyTransfer[] }; error?: { message?: string } }>(
      `https://${network}.g.alchemy.com/v2/${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'alchemy_getAssetTransfers',
          params: [
            {
              fromBlock: '0x0',
              toBlock: 'latest',
              fromAddress: address,
              category: ['external', 'erc20'],
              withMetadata: false,
              excludeZeroValue: true,
              maxCount: `0x${limit.toString(16)}`,
              order: 'desc',
            },
          ],
        }),
      },
      `alchemy_getAssetTransfers recipients (${chain})`,
      { retries: 2 },
    );
    if (json.error) throw new NonRetryableError(json.error.message ?? 'alchemy_getAssetTransfers error');
    return (json.result?.transfers ?? []).map((t) => (t.to ?? '').toLowerCase()).filter(Boolean);
  }

  /** Names for NFT contracts we couldn't resolve from our own DB. */
  async fetchContractNames(chain: string, contracts: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const network = ALCHEMY_NETWORK[chain];
    if (!network) return names;
    for (const batch of chunk(contracts, 100)) {
      try {
        const json = await fetchJsonWithRetry<{ contracts?: Array<{ address?: string; name?: string; openSeaMetadata?: { collectionName?: string } }> }>(
          `https://${network}.g.alchemy.com/nft/v3/${this.apiKey}/getContractMetadataBatch`,
          { method: 'POST', headers: { 'Content-Type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ contractAddresses: batch }) },
          `getContractMetadataBatch (${chain})`,
          { retries: 2 },
        );
        for (const c of json.contracts ?? []) {
          const name = c.openSeaMetadata?.collectionName || c.name;
          if (c.address && name) names.set(c.address.toLowerCase(), name);
        }
      } catch (err) {
        this.logger.warn(`Contract name lookup failed on ${chain}: ${(err as Error).message}`);
      }
    }
    return names;
  }
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
