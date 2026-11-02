import { decodeEventLog, parseAbi, toEventSelector } from 'viem';

/**
 * Recover NFT sale prices from the sale transaction itself, replacing Alchemy's
 * getNFTSales (deprecated and now returning 404).
 *
 * Two sources, in order:
 *  1. Seaport `OrderFulfilled` events (OpenSea, Magic Eden and most other
 *     Seaport-based marketplaces). These list every payment in the order, so
 *     they give an exact buyer price and the seller's net after fees.
 *  2. A payment-flow fallback for everything else (Blur, direct contract
 *     sales): what the buyer paid in the transaction (the ETH sent with the
 *     transaction, plus wrapped-native / Blur Pool transfers out of the buyer's
 *     wallet, less refunds), split across the NFTs the buyer received in it.
 *     The seller's net is what they received: wrapped-native transfers, plus
 *     plain ETH paid out by contracts, read from Alchemy internal transfers the
 *     same way the Money tab does. On chains without internal transfers the
 *     seller is assumed to have received the full price.
 *
 * Only the chain's native coin and its 1:1 equivalents count as payment. A sale
 * paid in any other token (USDC, APE on Ethereum, …) gets no price rather than
 * a wrong one.
 */

export interface SalePrice {
  /** What the buyer paid all-in (cost basis), in the chain's native coin. */
  gross: number;
  /** What the seller received after marketplace fee and royalty, in the native coin (null if unknown). */
  sellerNet: number | null;
}

export interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
}

export interface SaleReceipt {
  transactionHash: string;
  blockNumber?: string;
  from: string;
  logs: ReceiptLog[];
}

/** One transfer of a token in the scanned collection, from the transfer feed. */
export interface SaleMovement {
  tokenId: string;
  from: string;
  to: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** ERC-20 tokens worth exactly one unit of the chain's native coin. */
const NATIVE_EQUIVALENT_TOKENS: Record<string, string[]> = {
  ethereum: [
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0x0000000000a39bb272e79075ade125fd351887ac', // Blur Pool (BETH)
  ],
  base: ['0x4200000000000000000000000000000000000006'], // WETH
  polygon: ['0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270'], // WPOL
  abstract: [
    '0x3439153eb7af838ad19d56e1571fbd09333c2809', // WETH
    // zkSync-stack chains move native ETH through this system contract, which
    // logs an ERC-20 Transfer for every ETH movement (including contract payouts).
    '0x000000000000000000000000000000000000800a',
  ],
  apechain: ['0x48b62137edfa95a428d35c09e44256a739f6b557'], // WAPE
};

/** zkSync-stack chains: native ETH shows up as Transfer logs, so tx.value must not be added on top. */
const ZKSYNC_CHAINS = new Set(['abstract']);
/** zkSync bootloader: gas is paid to it and refunded from it as native Transfer logs. */
const ZKSYNC_BOOTLOADER = '0x0000000000000000000000000000000000008001';

const ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
  'struct SpentItem { uint8 itemType; address token; uint256 identifier; uint256 amount; }',
  'struct ReceivedItem { uint8 itemType; address token; uint256 identifier; uint256 amount; address recipient; }',
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, SpentItem[] offer, ReceivedItem[] consideration)',
]);

export const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)');
const TRANSFER_SINGLE_TOPIC = toEventSelector('TransferSingle(address,address,address,uint256,uint256)');
const TRANSFER_BATCH_TOPIC = toEventSelector('TransferBatch(address,address,address,uint256[],uint256[])');
export const ORDER_FULFILLED_TOPIC = toEventSelector(
  'OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])',
);

// Seaport ItemType
const NATIVE = 0;
const ERC20 = 1;
const NFT_ITEM_TYPES = new Set([2, 3, 4, 5]); // ERC721, ERC1155, and their criteria variants

interface SeaportItem {
  itemType: number;
  token: string;
  identifier: bigint;
  amount: bigint;
  recipient?: string;
}

interface DecodedOrder {
  offerer: string;
  offer: SeaportItem[];
  consideration: SeaportItem[];
}

interface NftMove {
  contract: string;
  tokenId: string;
  from: string;
  to: string;
  units: bigint;
}

interface FungibleMove {
  token: string;
  from: string;
  to: string;
  amount: bigint;
}

/** Key for one transfer leg of a token: `${tokenId}:${from}:${to}` (addresses lowercased). */
export function saleKey(m: SaleMovement): string {
  return `${m.tokenId}:${m.from.toLowerCase()}:${m.to.toLowerCase()}`;
}

/** Facts about a transaction that aren't in its receipt. */
export interface SaleContext {
  /** Wei sent with the transaction (null/undefined if unknown). */
  txValue?: bigint | null;
  /**
   * Plain ETH paid by contracts to each address in this transaction (Alchemy
   * internal transfers), the way the Money tab sees marketplace payouts and
   * refunds. Null/undefined when the chain doesn't expose them.
   */
  internalIn?: Map<string, bigint> | null;
  /** Whether an address has contract code (undefined if unknown). */
  isContract?: (address: string) => boolean | undefined;
}

/** True when this chain's sale prices can be derived (we know its native-equivalent tokens). */
export function supportsSalePrices(chain: string): boolean {
  return chain in NATIVE_EQUIVALENT_TOKENS;
}

/** True when the fallback needs the transaction's ETH value (not visible in the receipt). */
export function needsTxValue(chain: string): boolean {
  return !ZKSYNC_CHAINS.has(chain);
}

/** Chains where Alchemy reports internal (contract → wallet) ETH transfers. */
const INTERNAL_TRANSFER_CHAINS = new Set(['ethereum', 'polygon']);
export function hasInternalTransfers(chain: string): boolean {
  return INTERNAL_TRANSFER_CHAINS.has(chain);
}

/**
 * Wallet-to-wallet movements the payment-flow fallback may price: no Seaport
 * order in the receipt, not a zkSync chain. The caller fetches the extra
 * context (tx value, internal transfers, contract checks) only for these.
 */
export function needsFallbackContext(chain: string, receipt: SaleReceipt): boolean {
  if (ZKSYNC_CHAINS.has(chain)) return false;
  return !(receipt.logs ?? []).some((l) => l.topics?.[0]?.toLowerCase() === ORDER_FULFILLED_TOPIC);
}

/**
 * Sale prices for this collection's tokens that changed hands in one
 * transaction, keyed by saleKey() (one entry per transfer leg, since a token
 * can change hands twice in one tx). Mints and burns are never priced.
 *
 * `context` carries what the receipt can't show; it is only used by the
 * payment-flow fallback.
 */
export function deriveSalePrices(
  chain: string,
  collectionAddress: string,
  receipt: SaleReceipt,
  movements: SaleMovement[],
  context: SaleContext = {},
): Map<string, SalePrice> {
  const txValue = context.txValue ?? null;
  const internalIn = context.internalIn ?? null;
  const isContract = context.isContract ?? (() => undefined);
  const out = new Map<string, SalePrice>();
  const nativeTokens = new Set(NATIVE_EQUIVALENT_TOKENS[chain] ?? []);
  if (nativeTokens.size === 0) return out;
  const collection = collectionAddress.toLowerCase();
  const sales = movements
    .map((m) => ({ tokenId: m.tokenId, from: m.from.toLowerCase(), to: m.to.toLowerCase() }))
    .filter((m) => m.from && m.to && m.from !== ZERO_ADDRESS && m.to !== ZERO_ADDRESS);
  if (sales.length === 0) return out;

  const orders: DecodedOrder[] = [];
  const nftMoves: NftMove[] = [];
  const fungibleMoves: FungibleMove[] = [];
  /** Wallets that sent some other ERC-20 in this tx (USDC, APE on Ethereum, …). */
  const otherTokenSenders = new Set<string>();
  for (const log of receipt.logs ?? []) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    if (topic0 === ORDER_FULFILLED_TOPIC) {
      const order = decodeOrder(log);
      if (order) orders.push(order);
    } else if (topic0 === TRANSFER_TOPIC) {
      const address = log.address.toLowerCase();
      if (log.topics.length === 4) {
        // ERC-721: tokenId is indexed.
        nftMoves.push({
          contract: address,
          from: topicAddress(log.topics[1]),
          to: topicAddress(log.topics[2]),
          tokenId: BigInt(log.topics[3]).toString(),
          units: 1n,
        });
      } else if (log.topics.length === 3) {
        const from = topicAddress(log.topics[1]);
        if (!nativeTokens.has(address)) {
          otherTokenSenders.add(from);
          continue;
        }
        const amount = safeBigInt(log.data);
        if (amount !== null) {
          fungibleMoves.push({ token: address, from, to: topicAddress(log.topics[2]), amount });
        }
      }
    } else if (topic0 === TRANSFER_SINGLE_TOPIC || topic0 === TRANSFER_BATCH_TOPIC) {
      nftMoves.push(...decode1155(log));
    }
  }

  // 1. Seaport. Each order prices the tokens it moved, tagged with its side:
  //    a listing (the offerer sells) or a bid (the offerer buys and pays).
  const candidates = new Map<string, SeaportCandidate[]>();
  const addCandidate = (tokenId: string, c: SeaportCandidate) => {
    const list = candidates.get(tokenId) ?? [];
    list.push(c);
    candidates.set(tokenId, list);
  };
  for (const order of orders) {
    const offerNfts = order.offer.filter((i) => NFT_ITEM_TYPES.has(i.itemType));
    const considerationNfts = order.consideration.filter((i) => NFT_ITEM_TYPES.has(i.itemType));
    const offerPay = paymentTotal(order.offer, nativeTokens);
    const considerationPay = paymentTotal(order.consideration, nativeTokens);
    if (offerPay === null || considerationPay === null) continue; // paid in a token we can't value

    if (offerNfts.length > 0 && offerPay === 0n && considerationNfts.length === 0) {
      // Listing: the offerer sells NFTs; consideration is the payments.
      const units = nftUnits(offerNfts);
      if (considerationPay === 0n || units === 0n) continue;
      const toSeller = paymentTotal(
        order.consideration.filter((i) => (i.recipient ?? '').toLowerCase() === order.offerer),
        nativeTokens,
      )!;
      for (const item of offerNfts) {
        if (item.token.toLowerCase() !== collection) continue;
        addCandidate(item.identifier.toString(), {
          side: 'listing',
          offerer: order.offerer,
          price: {
            gross: toNative((considerationPay * itemUnits(item)) / units),
            // Payout sent somewhere other than the offerer: we can't tell what
            // the seller kept, so leave their side unpriced rather than zero.
            sellerNet: toSeller > 0n ? toNative((toSeller * itemUnits(item)) / units) : null,
          },
        });
      }
    } else if (offerNfts.length === 0 && offerPay > 0n && considerationNfts.length > 0) {
      // Bid: the offerer pays; consideration is the NFTs it receives plus fees
      // taken out of its payment. The seller gets what's left.
      const units = nftUnits(considerationNfts);
      if (units === 0n) continue;
      const net = offerPay > considerationPay ? offerPay - considerationPay : 0n;
      for (const item of considerationNfts) {
        if (item.token.toLowerCase() !== collection) continue;
        addCandidate(item.identifier.toString(), {
          side: 'bid',
          offerer: order.offerer,
          price: {
            gross: toNative((offerPay * itemUnits(item)) / units),
            sellerNet: toNative((net * itemUnits(item)) / units),
          },
        });
      }
    }
  }
  for (const sale of sales) {
    const price = pickSeaportPrice(candidates.get(sale.tokenId) ?? [], sale);
    if (price && price.gross > 0) out.set(saleKey(sale), price);
  }
  // Any Seaport activity means the payment flows below are mixed up with
  // orders we've already read; don't guess on top of them.
  if (orders.length > 0) return out;

  // 2. Payment-flow fallback, per buyer.
  const received = nftMoves.filter((m) => m.from !== ZERO_ADDRESS);
  // A sweep that also bought other collections can't be split fairly without
  // per-item prices, so leave it unpriced.
  if (received.length === 0 || received.some((m) => m.contract !== collection)) return out;
  const zksync = ZKSYNC_CHAINS.has(chain);
  const txFrom = (receipt.from ?? '').toLowerCase();
  const allToOneWallet = new Set(received.map((m) => m.to)).size === 1;
  const buyers = new Set(sales.filter((s) => !out.has(saleKey(s))).map((s) => s.to));
  for (const buyer of buyers) {
    if (otherTokenSenders.has(buyer)) continue; // partly paid in a token we can't value
    const units = received.filter((m) => m.to === buyer).reduce((sum, m) => sum + m.units, 0n);
    if (units === 0n) continue;

    // Native-equivalent token flows are logged, refunds included, so net them.
    let paid = 0n;
    for (const f of fungibleMoves) {
      if (zksync && (f.to === ZKSYNC_BOOTLOADER || f.from === ZKSYNC_BOOTLOADER)) continue; // gas and its refund
      if (f.from === buyer) paid += f.amount;
      if (f.to === buyer) paid -= f.amount;
    }
    // ETH sent with the tx. With internal transfers known, refunds of it are
    // netted out; without them, only trust it for a single NFT bought alone.
    const sentValue = !zksync && txFrom === buyer && txValue !== null && txValue > 0n;
    if (sentValue) {
      if (!allToOneWallet || (!internalIn && units !== 1n)) continue;
      paid += txValue!;
    }
    if (internalIn) paid -= internalIn.get(buyer) ?? 0n;
    if (paid <= 0n) continue;
    const grossPerUnit = paid / units;

    for (const sale of sales) {
      if (sale.to !== buyer || out.has(saleKey(sale))) continue;
      const seller = sale.from;
      const sellerUnits = received.filter((m) => m.from === seller).reduce((sum, m) => sum + m.units, 0n);
      const toSeller =
        fungibleMoves.filter((f) => f.to === seller && f.from !== ZKSYNC_BOOTLOADER).reduce((sum, f) => sum + f.amount, 0n) +
        (internalIn?.get(seller) ?? 0n);
      let netPerUnit: bigint;
      if (toSeller > 0n && sellerUnits > 0n) {
        netPerUnit = toSeller / sellerUnits;
        if (netPerUnit > grossPerUnit) netPerUnit = grossPerUnit;
      } else {
        // The seller visibly received nothing. Where every ETH move is visible
        // (zkSync logs, internal transfers), this isn't a sale. Elsewhere a
        // plain-ETH payout is invisible: accept it only from an ordinary
        // wallet, since a contract releasing an NFT (loan repayment,
        // unstaking) is not selling it.
        if (zksync || internalIn || isContract(seller) !== false) continue;
        netPerUnit = grossPerUnit;
      }
      out.set(saleKey(sale), { gross: toNative(grossPerUnit), sellerNet: toNative(netPerUnit) });
    }
  }
  return out;
}

interface SeaportCandidate {
  side: 'listing' | 'bid';
  offerer: string;
  price: SalePrice;
}

/**
 * The Seaport price for one transfer leg. An order whose offerer is on this
 * leg wins (bid offerer = recipient, listing offerer = sender), bids first:
 * when a bid is accepted via matched orders, the seller's counter-order lists
 * only their net payout. With no direct match (a router hop), use the token's
 * order only if there is one listing and/or one bid for it, not several.
 */
function pickSeaportPrice(list: SeaportCandidate[], sale: { from: string; to: string }): SalePrice | null {
  if (list.length === 0) return null;
  const bid = list.find((c) => c.side === 'bid' && c.offerer === sale.to);
  const listing = list.find((c) => c.side === 'listing' && c.offerer === sale.from);
  if (bid) return bid.price;
  if (listing) return listing.price;
  const bids = list.filter((c) => c.side === 'bid');
  const listings = list.filter((c) => c.side === 'listing');
  if (bids.length > 1 || listings.length > 1) return null;
  return (bids[0] ?? listings[0]).price;
}

function decodeOrder(log: ReceiptLog): DecodedOrder | null {
  try {
    const { args } = decodeEventLog({
      abi: ABI,
      eventName: 'OrderFulfilled',
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      data: log.data as `0x${string}`,
    });
    return {
      offerer: args.offerer.toLowerCase(),
      offer: args.offer.map((i) => ({ ...i, itemType: Number(i.itemType) })),
      consideration: args.consideration.map((i) => ({ ...i, itemType: Number(i.itemType) })),
    };
  } catch {
    return null;
  }
}

function decode1155(log: ReceiptLog): NftMove[] {
  try {
    const decoded = decodeEventLog({
      abi: ABI,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      data: log.data as `0x${string}`,
    });
    const contract = log.address.toLowerCase();
    if (decoded.eventName === 'TransferSingle') {
      const { from, to, id, value } = decoded.args;
      return [{ contract, from: from.toLowerCase(), to: to.toLowerCase(), tokenId: id.toString(), units: value }];
    }
    if (decoded.eventName === 'TransferBatch') {
      const { from, to, ids, values } = decoded.args;
      return ids.map((id, i) => ({
        contract,
        from: from.toLowerCase(),
        to: to.toLowerCase(),
        tokenId: id.toString(),
        units: values[i] ?? 0n,
      }));
    }
  } catch {
    // Not decodable as ERC-1155; ignore.
  }
  return [];
}

/** Sum of native / native-equivalent payments, or null if any payment is in another token. */
function paymentTotal(items: SeaportItem[], nativeTokens: Set<string>): bigint | null {
  let total = 0n;
  for (const item of items) {
    if (item.itemType === NATIVE) total += item.amount;
    else if (item.itemType === ERC20) {
      if (!nativeTokens.has(item.token.toLowerCase())) return null;
      total += item.amount;
    }
  }
  return total;
}

/** An NFT item's share of its order: its amount (1 for ERC-721), never less than 1. */
function itemUnits(item: SeaportItem): bigint {
  return item.amount > 0n ? item.amount : 1n;
}

function nftUnits(items: SeaportItem[]): bigint {
  return items.reduce((sum, i) => sum + itemUnits(i), 0n);
}

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function safeBigInt(hex: string): bigint | null {
  try {
    return hex && hex !== '0x' ? BigInt(hex) : 0n;
  } catch {
    return null;
  }
}

/** Wei (18 decimals — every native coin and equivalent above) to a native-coin number. */
function toNative(wei: bigint): number {
  return Number(wei) / 1e18;
}
