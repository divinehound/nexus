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
  robinhood: 'robinhood-mainnet',
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
  robinhood: { symbol: 'ETH', name: 'Ether' },
};

export const EVM_CHAINS = Object.keys(ALCHEMY_NETWORK);

/** zkSync-stack chains, where ETH itself is an ERC-20-like system contract. */
const ZKSYNC_CHAINS = new Set(['abstract']);
const ZKSYNC_ETH = '0x000000000000000000000000000000000000800a';
const ZKSYNC_BOOTLOADER = '0x0000000000000000000000000000000000008001';

/** Transactions per wallet+chain checked for payments hidden inside contract calls. */
const MAX_BALANCE_PROBES = 1000;
/** Ignore balance differences smaller than this (wei) — rounding and dust. */
const BALANCE_PROBE_MIN_WEI = 10n ** 12n;

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
  /** Diagnostic counters surfaced on the page (see CashflowWalletCoverage.stats). */
  stats?: Record<string, number>;
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
    const categories = this.categoriesFor(chain);

    const outgoing = await this.pageTransfers(endpoint, chain, { fromAddress: address }, categories);
    const incoming = await this.pageTransfers(endpoint, chain, { toAddress: address }, categories);
    const truncated = outgoing.truncated || incoming.truncated;
    return this.process(endpoint, chain, address, outgoing.transfers, incoming.transfers, truncated, assets);
  }

  /**
   * Re-read only the given transactions for `address` — the re-import of
   * flagged transactions. Reads every transfer of the wallet in each tx's
   * block (so the balance check can tell whether the block held other txs of
   * the wallet), then keeps just the requested txs.
   */
  async fetchTxs(chain: string, address: string, hashes: string[], assets: Map<string, LedgerAsset>): Promise<ChainFetchResult> {
    const network = ALCHEMY_NETWORK[chain];
    if (!network) throw new Error(`Unsupported EVM chain ${chain}`);
    const endpoint = `https://${network}.g.alchemy.com/v2/${this.apiKey}`;
    const wanted = new Set(hashes.map((h) => h.toLowerCase()));
    const txs = await this.rpcBatch<{ blockNumber?: string | null }>(
      endpoint,
      'eth_getTransactionByHash',
      [...wanted].map((h) => [h]),
      'eth_getTransactionByHash batch',
    );
    const blocks = [...new Set(txs.map((t) => t?.blockNumber).filter((b): b is string => !!b))];

    const categories = this.categoriesFor(chain);
    const outgoing: AlchemyTransfer[] = [];
    const incoming: AlchemyTransfer[] = [];
    for (const block of blocks) {
      const range = { fromBlock: block, toBlock: block };
      outgoing.push(...(await this.pageTransfers(endpoint, chain, { ...range, fromAddress: address }, categories)).transfers);
      incoming.push(...(await this.pageTransfers(endpoint, chain, { ...range, toAddress: address }, categories)).transfers);
    }
    const r = await this.process(endpoint, chain, address, outgoing, incoming, false, assets);
    const movements = r.movements.filter((m) => wanted.has(m.txHash.toLowerCase()));
    const fees = r.fees.filter((f) => wanted.has(f.txHash.toLowerCase()));
    return { ...r, movements, fees, transfers: movements.length };
  }

  private categoriesFor(chain: string): string[] {
    const categories = ['external', 'erc20', 'erc721', 'erc1155'];
    if (INTERNAL_SUPPORTED.has(chain)) categories.push('internal');
    if (chain === 'ethereum') categories.push('specialnft');
    return categories;
  }

  private async process(
    endpoint: string,
    chain: string,
    address: string,
    outgoingTransfers: AlchemyTransfer[],
    incomingTransfers: AlchemyTransfer[],
    truncated: boolean,
    assets: Map<string, LedgerAsset>,
  ): Promise<ChainFetchResult> {
    const notes: string[] = [];
    const outgoing = { transfers: outgoingTransfers };
    const incoming = { transfers: incomingTransfers };
    // Self-transfers come back from both queries; keep one copy.
    const seen = new Set<string>();
    const all = [...outgoing.transfers, ...incoming.transfers].filter((t) => {
      const id = t.uniqueId ?? `${t.hash}:${t.category}:${t.rawContract?.address ?? ''}:${t.erc721TokenId ?? t.tokenId ?? ''}:${t.rawContract?.value ?? ''}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    const transfers = ZKSYNC_CHAINS.has(chain) ? normalizeZkSyncEth(all) : all;

    // Fill missing block timestamps (some networks, e.g. Abstract, omit them).
    const missingBlocks = [...new Set(transfers.filter((t) => !t.metadata?.blockTimestamp).map((t) => t.blockNum))];
    const blockTimes = missingBlocks.length > 0 ? await this.fetchBlockTimestamps(endpoint, missingBlocks) : new Map<string, Date>();

    const movements: LedgerMovement[] = [];
    const txTimes = new Map<string, Date>();
    const txBlocks = new Map<string, string>();
    for (const t of transfers) {
      txBlocks.set(t.hash, t.blockNum);
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

    // Payments the transfer index can't see (ETH moved inside a contract call on
    // chains without internal tracing, or by a smart-contract wallet) show up
    // in the wallet's balance. Probe the txs that look incomplete.
    const probes = balanceProbeCandidates(movements, txBlocks, !INTERNAL_SUPPORTED.has(chain)).slice(
      0,
      MAX_BALANCE_PROBES,
    );
    let inferredCount = 0;
    if (probes.length > 0) {
      try {
        const feeWei = new Map(fees.map((f) => [f.txHash, BigInt(Math.round(f.feeNative * 1e18))]));
        const deltas = await this.fetchBalanceDeltas(endpoint, address, probes.map((p) => p.block));
        const nativeAsset = evmAssetFor(chain, { category: 'external' } as AlchemyTransfer, assets);
        probes.forEach((probe, i) => {
          const delta = deltas[i];
          if (delta === null) return;
          const inferred = inferHiddenNative(delta, feeWei.get(probe.txHash) ?? 0n, probe.visibleNativeWei);
          if (inferred === 0n) return;
          movements.push({
            chain,
            txHash: probe.txHash,
            timestamp: probe.timestamp,
            wallet: address.toLowerCase(),
            direction: inferred < 0n ? 'out' : 'in',
            asset: nativeAsset,
            tokenId: null,
            amount: scaled(inferred < 0n ? -inferred : inferred, 18),
            counterparty: 'contract',
            inferred: true,
          });
          inferredCount++;
        });
      } catch (err) {
        this.logger.warn(`${chain} balance probe failed for ${address}: ${(err as Error).message}`);
        notes.push(`${chain} ${shortAddress(address)}: couldn't check balances for payments made inside contract calls.`);
      }
    }

    const stats = {
      transfers: all.length,
      nftLegs: movements.filter((m) => m.asset.kind === 'nft').length,
      tokenLegs: movements.filter((m) => m.asset.kind === 'fungible').length,
      nativeLegs: movements.filter((m) => m.asset.kind === 'native' && !m.inferred).length,
      balanceChecks: probes.length,
      inferredPayments: inferredCount,
    };
    return { movements, fees, transfers: all.length, truncated, notes, stats };
  }

  private async pageTransfers(
    endpoint: string,
    chain: string,
    filter: { fromAddress?: string; toAddress?: string; fromBlock?: string; toBlock?: string },
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
        // Newest first: if a very active wallet hits the page cap, it's the
        // oldest history that gets cut, not the recent buys, sales and gas.
        order: 'desc',
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

  /** Native balance change across each block (balance at N minus balance at N−1), in wei. */
  private async fetchBalanceDeltas(endpoint: string, address: string, blocks: string[]): Promise<Array<bigint | null>> {
    const out: Array<bigint | null> = [];
    for (const batch of chunk(blocks, 50)) {
      const params = batch.flatMap((b) => {
        const n = BigInt(b);
        return [
          [address, `0x${(n - 1n).toString(16)}`],
          [address, `0x${n.toString(16)}`],
        ];
      });
      const rows = await this.rpcBatch<string>(endpoint, 'eth_getBalance', params, 'eth_getBalance batch');
      for (let i = 0; i < batch.length; i++) {
        const before = hexToBigInt(rows[2 * i]);
        const after = hexToBigInt(rows[2 * i + 1]);
        out.push(before === null || after === null ? null : after - before);
      }
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

/**
 * On zkSync-stack chains ETH moves also appear as ERC-20 `Transfer`s of the
 * 0x…800a system contract. Drop the fee plumbing (to/from the bootloader) and
 * copies of ETH moves already reported as native; keep the rest as native ETH
 * (e.g. value a contract forwarded, which has no 'external' record).
 */
export function normalizeZkSyncEth(transfers: AlchemyTransfer[]): AlchemyTransfer[] {
  const nativeKeys = new Set(
    transfers
      .filter((t) => t.category === 'external' || t.category === 'internal')
      .map((t) => `${t.hash}:${(t.from ?? '').toLowerCase()}:${(t.to ?? '').toLowerCase()}:${hexToBigInt(t.rawContract?.value) ?? ''}`),
  );
  const out: AlchemyTransfer[] = [];
  for (const t of transfers) {
    if (t.category !== 'erc20' || (t.rawContract?.address ?? '').toLowerCase() !== ZKSYNC_ETH) {
      out.push(t);
      continue;
    }
    const from = (t.from ?? '').toLowerCase();
    const to = (t.to ?? '').toLowerCase();
    if (from === ZKSYNC_BOOTLOADER || to === ZKSYNC_BOOTLOADER) continue;
    if (nativeKeys.has(`${t.hash}:${from}:${to}:${hexToBigInt(t.rawContract?.value) ?? ''}`)) continue;
    out.push({ ...t, category: 'internal', asset: 'ETH', rawContract: { value: t.rawContract?.value ?? null, address: null, decimal: '0x12' } });
  }
  return out;
}

export interface BalanceProbe {
  txHash: string;
  block: string;
  timestamp: Date;
  /** Native coin already visible in the tx for this wallet (in − out), in wei. */
  visibleNativeWei: bigint;
}

/**
 * Txs where the wallet got or gave away an asset but no payment is visible —
 * a mint/buy with no money out, or a sale with no money in. Txs sharing a
 * block with another of the wallet's txs are skipped: the balance change
 * across the block would mix them.
 */
export function balanceProbeCandidates(
  movements: LedgerMovement[],
  txBlocks: Map<string, string>,
  /**
   * On chains without internal-transfer tracing, probe every tx that moved an
   * NFT/token — not only ones with no visible payment — so ETH that came back
   * inside the call (a sweep router refunding unfilled orders, part of a sale
   * paid out by a contract) is accounted for too.
   */
  everyAssetTx = false,
): BalanceProbe[] {
  const byTx = new Map<string, LedgerMovement[]>();
  for (const m of movements) byTx.set(m.txHash, [...(byTx.get(m.txHash) ?? []), m]);
  const txsPerBlock = new Map<string, number>();
  for (const block of txBlocks.values()) txsPerBlock.set(block, (txsPerBlock.get(block) ?? 0) + 1);

  const probes: BalanceProbe[] = [];
  for (const [txHash, legs] of byTx) {
    const block = txBlocks.get(txHash);
    if (!block || (txsPerBlock.get(block) ?? 0) > 1) continue;
    const assetIn = legs.some((m) => m.direction === 'in' && !m.asset.price);
    const assetOut = legs.some((m) => m.direction === 'out' && !m.asset.price);
    const moneyIn = legs.some((m) => m.direction === 'in' && m.asset.price);
    const moneyOut = legs.some((m) => m.direction === 'out' && m.asset.price);
    const looksUnpaid = assetIn && !assetOut && !moneyOut;
    const looksUnsold = assetOut && !assetIn && !moneyIn;
    if (!looksUnpaid && !looksUnsold && !(everyAssetTx && (assetIn || assetOut))) continue;
    let visibleNativeWei = 0n;
    for (const m of legs) {
      if (m.asset.kind !== 'native') continue;
      const wei = BigInt(Math.round(m.amount * 1e18));
      visibleNativeWei += m.direction === 'in' ? wei : -wei;
    }
    probes.push({ txHash, block, timestamp: legs[0].timestamp, visibleNativeWei });
  }
  // Newest first, matching the transfer paging.
  return probes.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}

/**
 * The part of a wallet's balance change the transfer index didn't explain:
 * balance delta, plus the gas it paid (which also left the balance), minus
 * native moves already visible. Tiny differences are treated as zero.
 */
export function inferHiddenNative(balanceDeltaWei: bigint, gasWei: bigint, visibleNativeWei: bigint): bigint {
  const hidden = balanceDeltaWei + gasWei - visibleNativeWei;
  const abs = hidden < 0n ? -hidden : hidden;
  return abs < BALANCE_PROBE_MIN_WEI ? 0n : hidden;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
