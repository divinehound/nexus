import { encodeAbiParameters, pad, parseAbiParameters, toHex } from 'viem';
import { deriveSalePrices, saleKey, ORDER_FULFILLED_TOPIC, TRANSFER_TOPIC, type ReceiptLog, type SaleReceipt } from './evm-sale-prices';

const COLLECTION = '0x35508ce65b3f5c0f5569502092015fd58b0455bf';
const OTHER_NFT = '0x1111111111111111111111111111111111111111';
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const BETH = '0x0000000000a39bb272e79075ade125fd351887ac';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ABSTRACT_ETH = '0x000000000000000000000000000000000000800a';
const BOOTLOADER = '0x0000000000000000000000000000000000008001';
const ZERO = '0x0000000000000000000000000000000000000000';

const SELLER = '0x5e11e50000000000000000000000000000000001';
const BUYER = '0xb0b0000000000000000000000000000000000002';
const OS_FEE = '0x0000a26b00c1f0df003000390027140000faa719';
const CREATOR = '0xc0ffee0000000000000000000000000000000003';
const FRIEND = '0xf00d000000000000000000000000000000000004';

const eth = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const topicAddr = (a: string) => pad(a as `0x${string}`, { size: 32 }).toLowerCase();

function nftTransfer(from: string, to: string, tokenId: number, contract = COLLECTION): ReceiptLog {
  return {
    address: contract,
    topics: [TRANSFER_TOPIC, topicAddr(from), topicAddr(to), pad(toHex(tokenId), { size: 32 })],
    data: '0x',
  };
}

function tokenTransfer(token: string, from: string, to: string, amount: bigint): ReceiptLog {
  return { address: token, topics: [TRANSFER_TOPIC, topicAddr(from), topicAddr(to)], data: pad(toHex(amount), { size: 32 }) };
}

type Item = { itemType: number; token: string; identifier: bigint; amount: bigint };
type Received = Item & { recipient: string };
const nativeItem = (amount: bigint, recipient: string): Received => ({ itemType: 0, token: ZERO, identifier: 0n, amount, recipient });
const erc20Item = (token: string, amount: bigint, recipient = ZERO): Received => ({ itemType: 1, token, identifier: 0n, amount, recipient });
const nftItem = (tokenId: number, recipient = ZERO, token = COLLECTION): Received => ({
  itemType: 2,
  token,
  identifier: BigInt(tokenId),
  amount: 1n,
  recipient,
});
const spent = ({ itemType, token, identifier, amount }: Item) => ({ itemType, token, identifier, amount });

function orderFulfilled(offerer: string, recipient: string, offer: Item[], consideration: Received[]): ReceiptLog {
  const data = encodeAbiParameters(
    parseAbiParameters(
      'bytes32, address, (uint8,address,uint256,uint256)[], (uint8,address,uint256,uint256,address)[]',
    ),
    [
      pad('0x01', { size: 32 }),
      recipient as `0x${string}`,
      offer.map((i) => [i.itemType, i.token as `0x${string}`, i.identifier, i.amount] as const),
      consideration.map(
        (i) => [i.itemType, i.token as `0x${string}`, i.identifier, i.amount, i.recipient as `0x${string}`] as const,
      ),
    ],
  );
  return { address: SEAPORT, topics: [ORDER_FULFILLED_TOPIC, topicAddr(offerer), topicAddr(ZERO)], data };
}

const receipt = (from: string, logs: ReceiptLog[]): SaleReceipt => ({ transactionHash: '0xabc', from, logs });
const sale = (tokenId: number, from = SELLER, to = BUYER) => ({ tokenId: String(tokenId), from, to });
const k = (tokenId: number, from = SELLER, to = BUYER) => saleKey(sale(tokenId, from, to));

describe('deriveSalePrices', () => {
  describe('Seaport', () => {
    it('prices an ETH listing: gross is everything paid, net is what reached the seller', () => {
      const r = receipt(BUYER, [
        orderFulfilled(SELLER, BUYER, [spent(nftItem(7))], [nativeItem(eth(0.9), SELLER), nativeItem(eth(0.05), OS_FEE), nativeItem(eth(0.05), CREATOR)]),
        nftTransfer(SELLER, BUYER, 7),
      ]);
      const prices = deriveSalePrices('ethereum', COLLECTION, r, [sale(7)], { txValue: eth(1) });
      expect(prices.get(k(7))!.gross).toBeCloseTo(1, 9);
      expect(prices.get(k(7))!.sellerNet).toBeCloseTo(0.9, 9);
    });

    it('prices an accepted WETH bid from the bid order, not the seller counter-order', () => {
      // OpenSea accept-offer: matched orders. The bidder offers 1 WETH for the NFT
      // plus fees; the seller's counter-order only lists their net payout.
      const r = receipt(SELLER, [
        orderFulfilled(BUYER, ZERO, [spent(erc20Item(WETH, eth(1)))], [nftItem(7, BUYER), erc20Item(WETH, eth(0.025), OS_FEE), erc20Item(WETH, eth(0.05), CREATOR)]),
        orderFulfilled(SELLER, ZERO, [spent(nftItem(7))], [erc20Item(WETH, eth(0.925), SELLER)]),
        nftTransfer(SELLER, BUYER, 7),
        tokenTransfer(WETH, BUYER, SELLER, eth(0.925)),
      ]);
      const prices = deriveSalePrices('ethereum', COLLECTION, r, [sale(7)], { txValue: 0n });
      expect(prices.get(k(7))!.gross).toBeCloseTo(1, 9);
      expect(prices.get(k(7))!.sellerNet).toBeCloseTo(0.925, 9);
    });

    it('splits a bundle listing across its NFTs', () => {
      const r = receipt(BUYER, [
        orderFulfilled(SELLER, BUYER, [spent(nftItem(1)), spent(nftItem(2))], [nativeItem(eth(1.8), SELLER), nativeItem(eth(0.2), OS_FEE)]),
      ]);
      const prices = deriveSalePrices('ethereum', COLLECTION, r, [sale(1), sale(2)], { txValue: eth(2) });
      expect(prices.get(k(1))!.gross).toBeCloseTo(1, 9);
      expect(prices.get(k(2))!.sellerNet).toBeCloseTo(0.9, 9);
    });

    it('prices each leg of a listing bought and sold into a bid in one tx by its own order', () => {
      const BOT = '0xb07000000000000000000000000000000000000b';
      const r = receipt(BOT, [
        orderFulfilled(SELLER, BOT, [spent(nftItem(7))], [nativeItem(eth(0.95), SELLER), nativeItem(eth(0.05), OS_FEE)]),
        orderFulfilled(BUYER, BOT, [spent(erc20Item(WETH, eth(2)))], [nftItem(7, BUYER), erc20Item(WETH, eth(0.05), OS_FEE)]),
        nftTransfer(SELLER, BOT, 7),
        nftTransfer(BOT, BUYER, 7),
      ]);
      const prices = deriveSalePrices('ethereum', COLLECTION, r, [sale(7, SELLER, BOT), sale(7, BOT, BUYER)], { txValue: eth(1) });
      expect(prices.get(k(7, SELLER, BOT))!.gross).toBeCloseTo(1, 9);
      expect(prices.get(k(7, SELLER, BOT))!.sellerNet).toBeCloseTo(0.95, 9);
      expect(prices.get(k(7, BOT, BUYER))!.gross).toBeCloseTo(2, 9);
      expect(prices.get(k(7, BOT, BUYER))!.sellerNet).toBeCloseTo(1.95, 9);
    });

    it('leaves the seller side unpriced when a listing pays out to another address', () => {
      const r = receipt(BUYER, [
        orderFulfilled(SELLER, BUYER, [spent(nftItem(7))], [nativeItem(eth(0.95), FRIEND), nativeItem(eth(0.05), OS_FEE)]),
      ]);
      const price = deriveSalePrices('ethereum', COLLECTION, r, [sale(7)]).get(k(7))!;
      expect(price.gross).toBeCloseTo(1, 9);
      expect(price.sellerNet).toBeNull();
    });

    it('leaves a sale paid in a token other than the native coin unpriced', () => {
      const r = receipt(BUYER, [
        orderFulfilled(SELLER, BUYER, [spent(nftItem(7))], [erc20Item(USDC, 3_000_000_000n, SELLER)]),
        nftTransfer(SELLER, BUYER, 7),
      ]);
      expect(deriveSalePrices('ethereum', COLLECTION, r, [sale(7)], { txValue: 0n }).size).toBe(0);
    });

    it('does not fall back to payment flows when Seaport is in the transaction', () => {
      const r = receipt(BUYER, [
        orderFulfilled(SELLER, BUYER, [spent(nftItem(7))], [erc20Item(USDC, 1n, SELLER)]),
        nftTransfer(SELLER, BUYER, 7),
      ]);
      expect(deriveSalePrices('ethereum', COLLECTION, r, [sale(7)], { txValue: eth(1) }).size).toBe(0);
    });
  });

  describe('payment-flow fallback', () => {
    it('uses the ETH the buyer sent and the payout contracts made to the seller (e.g. a Blur listing)', () => {
      const r = receipt(BUYER, [nftTransfer(SELLER, BUYER, 7)]);
      const internalIn = new Map([[SELLER, eth(1.99)], [BUYER, 0n]]);
      const prices = deriveSalePrices('ethereum', COLLECTION, r, [sale(7)], { txValue: eth(2), internalIn });
      expect(prices.get(k(7))!.gross).toBeCloseTo(2, 9);
      expect(prices.get(k(7))!.sellerNet).toBeCloseTo(1.99, 9);
    });

    it('without internal transfers, assumes a wallet seller got the full price', () => {
      const r = receipt(BUYER, [nftTransfer(SELLER, BUYER, 7)]);
      const prices = deriveSalePrices('base', COLLECTION, r, [sale(7)], { txValue: eth(2), isContract: () => false });
      expect(prices.get(k(7))).toEqual({ gross: 2, sellerNet: 2 });
    });

    it('leaves a sale unpriced when a contract released the NFT and got nothing (loan repayment, unstaking)', () => {
      const ESCROW = '0xe5c0000000000000000000000000000000000005';
      const r = receipt(BUYER, [nftTransfer(ESCROW, BUYER, 7), tokenTransfer(WETH, BUYER, FRIEND, eth(10.3))]);
      expect(deriveSalePrices('base', COLLECTION, r, [sale(7, ESCROW)], { txValue: 0n, isContract: () => true }).size).toBe(0);
      expect(deriveSalePrices('base', COLLECTION, r, [sale(7, ESCROW)], { txValue: 0n }).size).toBe(0);
      const internalIn = new Map([[ESCROW, 0n], [BUYER, 0n]]);
      expect(deriveSalePrices('ethereum', COLLECTION, r, [sale(7, ESCROW)], { txValue: 0n, internalIn }).size).toBe(0);
    });

    it('nets ETH refunds out of a sweep when internal transfers are known', () => {
      const r = receipt(BUYER, [nftTransfer(SELLER, BUYER, 1), nftTransfer(FRIEND, BUYER, 2)]);
      const internalIn = new Map([[SELLER, eth(1)], [FRIEND, eth(1)], [BUYER, eth(1)]]);
      const prices = deriveSalePrices('ethereum', COLLECTION, r, [sale(1), sale(2, FRIEND)], { txValue: eth(3), internalIn });
      expect(prices.get(k(1))!.gross).toBeCloseTo(1, 9);
      expect(prices.get(k(2, FRIEND))!.gross).toBeCloseTo(1, 9);
    });

    it('does not trust tx value for a multi-NFT sweep when refunds are invisible', () => {
      const r = receipt(BUYER, [nftTransfer(SELLER, BUYER, 1), nftTransfer(FRIEND, BUYER, 2)]);
      expect(deriveSalePrices('base', COLLECTION, r, [sale(1), sale(2, FRIEND)], { txValue: eth(3), isContract: () => false }).size).toBe(0);
    });

    it('skips sweeps that also bought other collections', () => {
      const r = receipt(BUYER, [nftTransfer(SELLER, BUYER, 1), nftTransfer(SELLER, BUYER, 99, OTHER_NFT)]);
      const internalIn = new Map([[SELLER, eth(10)], [BUYER, 0n]]);
      expect(deriveSalePrices('ethereum', COLLECTION, r, [sale(1)], { txValue: eth(10.1), internalIn }).size).toBe(0);
    });

    it('prices each bidder separately in a bulk sale into Blur Pool bids', () => {
      const r = receipt(SELLER, [
        nftTransfer(SELLER, BUYER, 1),
        nftTransfer(SELLER, FRIEND, 2),
        tokenTransfer(BETH, BUYER, SELLER, eth(1)),
        tokenTransfer(BETH, FRIEND, SELLER, eth(2)),
      ]);
      const prices = deriveSalePrices('ethereum', COLLECTION, r, [sale(1), sale(2, SELLER, FRIEND)], { txValue: 0n });
      expect(prices.get(k(1))!.gross).toBeCloseTo(1, 9);
      expect(prices.get(k(2, SELLER, FRIEND))!.gross).toBeCloseTo(2, 9);
    });

    it('leaves a sale unpriced when the buyer also paid in another token', () => {
      const r = receipt(BUYER, [nftTransfer(SELLER, BUYER, 7), tokenTransfer(USDC, BUYER, SELLER, 1_000_000n)]);
      expect(deriveSalePrices('ethereum', COLLECTION, r, [sale(7)], { txValue: eth(0.1), internalIn: new Map([[SELLER, eth(0.1)], [BUYER, 0n]]) }).size).toBe(0);
    });

    it('reads Blur Pool bid payments and the seller net from them', () => {
      const r = receipt(SELLER, [
        nftTransfer(SELLER, BUYER, 7),
        tokenTransfer(BETH, BUYER, SELLER, eth(1.5)),
        tokenTransfer(BETH, BUYER, CREATOR, eth(0.0075)),
      ]);
      const prices = deriveSalePrices('ethereum', COLLECTION, r, [sale(7)], { txValue: 0n });
      expect(prices.get(k(7))!.gross).toBeCloseTo(1.5075, 9);
      expect(prices.get(k(7))!.sellerNet).toBeCloseTo(1.5, 9);
    });

    it('ignores ETH sent by someone other than the buyer', () => {
      // The seller sends the NFT and pays gas; nothing moved from the buyer.
      const r = receipt(SELLER, [nftTransfer(SELLER, BUYER, 7)]);
      expect(deriveSalePrices('ethereum', COLLECTION, r, [sale(7)], { txValue: eth(1) }).size).toBe(0);
    });

    it('skips transactions where NFTs land with more than one wallet', () => {
      const r = receipt(BUYER, [nftTransfer(SELLER, BUYER, 7), nftTransfer(BUYER, FRIEND, 7)]);
      const prices = deriveSalePrices('ethereum', COLLECTION, r, [sale(7), sale(7, BUYER, FRIEND)], { txValue: eth(1) });
      expect(prices.size).toBe(0);
    });

    it('never prices mints', () => {
      const r = receipt(BUYER, [nftTransfer(ZERO, BUYER, 7)]);
      expect(deriveSalePrices('ethereum', COLLECTION, r, [sale(7, ZERO)], { txValue: eth(0.1) }).size).toBe(0);
    });

    it('reads native ETH transfer logs on Abstract and ignores gas and tx.value', () => {
      const r = receipt(BUYER, [
        tokenTransfer(ABSTRACT_ETH, BUYER, BOOTLOADER, eth(0.001)),
        tokenTransfer(ABSTRACT_ETH, BUYER, SELLER, eth(0.95)),
        tokenTransfer(ABSTRACT_ETH, BUYER, CREATOR, eth(0.05)),
        nftTransfer(SELLER, BUYER, 7),
        tokenTransfer(ABSTRACT_ETH, BOOTLOADER, BUYER, eth(0.0004)),
        tokenTransfer(ABSTRACT_ETH, SELLER, BUYER, eth(0)),
      ]);
      const prices = deriveSalePrices('abstract', COLLECTION, r, [sale(7)], { txValue: eth(1) });
      expect(prices.get(k(7))!.gross).toBeCloseTo(1, 9);
      expect(prices.get(k(7))!.sellerNet).toBeCloseTo(0.95, 9);
    });

    it('returns nothing on chains without known native-equivalent tokens', () => {
      const r = receipt(BUYER, [nftTransfer(SELLER, BUYER, 7)]);
      expect(deriveSalePrices('solana', COLLECTION, r, [sale(7)], { txValue: eth(1) }).size).toBe(0);
    });
  });
});
