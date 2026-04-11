import bs58 from 'bs58';

/**
 * Parser registry for extracting NFT transfers from Helius enhanced transaction data.
 *
 * Each parser looks at a different signal:
 *  - mpl_core_transfer_v1: decodes MPL Core TransferV1 instructions directly
 *  - helius_events_nft:    uses Helius's parsed NFT sale/transfer events
 *  - spl_token_transfers:  uses Helius's tokenTransfers field (standard SPL tokens)
 *
 * All parsers run against every transaction; results are deduped by
 * (signature, mintAddress, fromWallet, toWallet, parserName) in the DB.
 *
 * Adding a new parser (e.g. LaunchMyNFT airdrop):
 *  1. Implement it here as a new function matching the Parser interface
 *  2. Add it to PARSERS below
 *  3. Mark affected signatures for review via the admin endpoint
 *  4. Next scan re-parses using stored raw_data (no new Helius calls)
 */

export type ParsedTransfer = {
  mintAddress: string;
  fromWallet: string; // '' for mint events
  toWallet: string; // '' for burn events
  parserName: string;
  programId: string | null;
};

export type ParserContext = {
  mintAddresses: Set<string>;
};

export type Parser = {
  name: string;
  run: (tx: any, ctx: ParserContext) => ParsedTransfer[];
};

export const MPL_CORE_PROGRAM_ID = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const MPL_CORE_TRANSFER_DISCRIMINATOR = 14;
const MPL_CORE_CREATE_V1_DISCRIMINATOR = 0;

/**
 * Parse MPL Core TransferV1 instructions (both top-level and CPI inner).
 *
 * Account layout for TransferV1:
 *   [0] asset       — the NFT being transferred
 *   [1] collection  — the collection (or MPL Core program ID placeholder)
 *   [2] payer       — signer paying fees
 *   [3] authority   — current owner, or placeholder if payer is owner
 *   [4] new_owner   — recipient
 *   [5] system_program — placeholder if unused
 *   [6] log_wrapper    — placeholder if unused
 *
 * NOTE: MPL Core CreateV1 appears to share discriminator 14 for assets minted
 * directly to a new owner. We still treat these as transfers from the fee payer
 * (effectively a mint-to-owner) since the ownership-change semantics are the same.
 */
const mplCoreTransferV1: Parser = {
  name: 'mpl_core_transfer_v1',
  run(tx, ctx) {
    const transfers: ParsedTransfer[] = [];
    const matches = new Map<string, ParsedTransfer>();

    const processInstr = (instr: { programId?: string; accounts?: string[]; data?: string }) => {
      if (instr.programId !== MPL_CORE_PROGRAM_ID) return;
      if (!instr.accounts || instr.accounts.length < 5) return;

      // First byte of base58-decoded data is the MPL Core instruction discriminator
      let discriminator: number | null = null;
      if (instr.data) {
        try {
          const decoded = bs58.decode(instr.data);
          if (decoded.length > 0) discriminator = decoded[0];
        } catch {
          // ignore bad base58
        }
      }
      if (discriminator !== MPL_CORE_TRANSFER_DISCRIMINATOR) return;

      const asset = instr.accounts[0];
      if (!ctx.mintAddresses.has(asset)) return;

      const payer = instr.accounts[2];
      const authority = instr.accounts[3];
      const newOwner = instr.accounts[4];

      // Placeholder detection: optional accounts use the program ID when unset
      const from = authority && authority !== MPL_CORE_PROGRAM_ID ? authority : payer;
      const to = newOwner;

      if (!from || !to || from === to) return;
      if (to === MPL_CORE_PROGRAM_ID) return; // sanity: new_owner shouldn't be the program

      const key = `${asset}:${from}:${to}`;
      if (!matches.has(key)) {
        matches.set(key, {
          mintAddress: asset,
          fromWallet: from,
          toWallet: to,
          parserName: 'mpl_core_transfer_v1',
          programId: MPL_CORE_PROGRAM_ID,
        });
      }
    };

    for (const instr of tx.instructions ?? []) {
      processInstr(instr);
      for (const inner of instr.innerInstructions ?? []) {
        processInstr(inner);
      }
    }

    transfers.push(...matches.values());
    return transfers;
  },
};

/**
 * Parse MPL Core CreateV1 instructions (both top-level and CPI inner).
 *
 * Critical for collections minted via Candy Machine V3, LaunchMyNFT, or any
 * other launchpad that CPIs into MPL Core. Without this, we see the transfer
 * chain starting from a "random" wallet (if any transfers happened later) or
 * nothing at all, and reconciliation fails because the initial mint-to-owner
 * event is missing.
 *
 * Account layout for CreateV1:
 *   [0] asset            — the new NFT being created
 *   [1] collection       — the collection (or MPL Core program ID placeholder)
 *   [2] authority        — update authority (or placeholder)
 *   [3] payer            — signer paying fees
 *   [4] owner            — initial owner (usually = payer for Candy Machine mints)
 *   [5] update_authority — (or placeholder)
 *   [6] system_program
 *   [7] log_wrapper      — (or placeholder)
 *
 * Discriminator: first byte of instruction data = 0.
 *
 * Emits: from='' (mint event), to=owner (or payer if owner is placeholder).
 */
const mplCoreCreateV1: Parser = {
  name: 'mpl_core_create_v1',
  run(tx, ctx) {
    const transfers: ParsedTransfer[] = [];
    const matches = new Map<string, ParsedTransfer>();

    const processInstr = (instr: { programId?: string; accounts?: string[]; data?: string }) => {
      if (instr.programId !== MPL_CORE_PROGRAM_ID) return;
      if (!instr.accounts || instr.accounts.length < 5) return;

      // First byte of base58-decoded data is the MPL Core instruction discriminator
      let discriminator: number | null = null;
      if (instr.data) {
        try {
          const decoded = bs58.decode(instr.data);
          if (decoded.length > 0) discriminator = decoded[0];
        } catch {
          // ignore bad base58
        }
      }
      if (discriminator !== MPL_CORE_CREATE_V1_DISCRIMINATOR) return;

      const asset = instr.accounts[0];
      if (!ctx.mintAddresses.has(asset)) return;

      const payer = instr.accounts[3];
      const owner = instr.accounts[4];

      // If owner slot is a real pubkey (not the placeholder), use it. Otherwise payer.
      const to = owner && owner !== MPL_CORE_PROGRAM_ID ? owner : payer;
      if (!to || to === MPL_CORE_PROGRAM_ID) return;

      // CreateV1 = mint event, no previous owner
      const key = `${asset}::${to}`;
      if (!matches.has(key)) {
        matches.set(key, {
          mintAddress: asset,
          fromWallet: '',
          toWallet: to,
          parserName: 'mpl_core_create_v1',
          programId: MPL_CORE_PROGRAM_ID,
        });
      }
    };

    for (const instr of tx.instructions ?? []) {
      processInstr(instr);
      for (const inner of instr.innerInstructions ?? []) {
        processInstr(inner);
      }
    }

    transfers.push(...matches.values());
    return transfers;
  },
};

/**
 * Parse Helius's pre-classified NFT events (marketplace sales, etc.).
 * The seller/buyer fields are on events.nft, not on individual NFT items.
 */
const heliusEventsNft: Parser = {
  name: 'helius_events_nft',
  run(tx, ctx) {
    const transfers: ParsedTransfer[] = [];
    const nftEvent = tx.events?.nft;
    if (!nftEvent?.nfts?.length) return transfers;

    const from = nftEvent.seller || '';
    const to = nftEvent.buyer || '';
    if (!from && !to) return transfers;

    const seen = new Set<string>();
    for (const nft of nftEvent.nfts) {
      const mint = nft.mint || '';
      if (!mint || !ctx.mintAddresses.has(mint)) continue;
      if (from && to && from === to) continue;
      const key = `${mint}:${from}:${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      transfers.push({
        mintAddress: mint,
        fromWallet: from,
        toWallet: to,
        parserName: 'helius_events_nft',
        programId: nftEvent.source || null,
      });
    }
    return transfers;
  },
};

/**
 * Parse Helius's tokenTransfers array (standard SPL token transfers).
 * Works for regular SPL NFTs, less relevant for MPL Core.
 */
const splTokenTransfers: Parser = {
  name: 'spl_token_transfers',
  run(tx, ctx) {
    const transfers: ParsedTransfer[] = [];
    const seen = new Set<string>();

    for (const transfer of tx.tokenTransfers ?? []) {
      const mint = transfer.mint || transfer.tokenAddress || '';
      if (!mint || !ctx.mintAddresses.has(mint)) continue;

      const from = transfer.fromUserAccount || transfer.fromTokenAccount || '';
      const to = transfer.toUserAccount || transfer.toTokenAccount || '';
      if (!from && !to) continue;
      if (from && to && from === to) continue;

      const key = `${mint}:${from}:${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      transfers.push({
        mintAddress: mint,
        fromWallet: from,
        toWallet: to,
        parserName: 'spl_token_transfers',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token program
      });
    }
    return transfers;
  },
};

/**
 * Parse Helius's accountData[].tokenBalanceChanges — balance-delta approach.
 *
 * Critical for CPI contexts where Helius doesn't populate top-level
 * tokenTransfers but DOES reflect the final post-state in accountData.
 * Examples: Metaplex Candy Machine V3 mints, LaunchMyNFT, and other
 * programs that invoke SPL token operations via inner instructions.
 *
 * Semantics:
 *  - Each tokenBalanceChange has `userAccount` (resolved wallet owner),
 *    `mint`, and a signed `rawTokenAmount.tokenAmount` (positive = received,
 *    negative = sent)
 *  - Group changes by mint. For each matching mint:
 *    - Accounts with positive deltas are receivers
 *    - Accounts with negative deltas are senders
 *    - If only a receiver exists, it's a mint event (from='')
 *    - If only a sender exists, it's a burn event (to='')
 */
const accountDataTokenBalances: Parser = {
  name: 'account_data_token_balances',
  run(tx, ctx) {
    const transfers: ParsedTransfer[] = [];
    const perMint = new Map<string, { from: string | null; to: string | null }>();

    for (const account of tx.accountData ?? []) {
      for (const change of account.tokenBalanceChanges ?? []) {
        const mint = change.mint || '';
        if (!mint || !ctx.mintAddresses.has(mint)) continue;
        if (!change.userAccount) continue;

        const amount = parseFloat(change.rawTokenAmount?.tokenAmount || '0');
        if (amount === 0) continue;

        const existing = perMint.get(mint) || { from: null, to: null };
        if (amount > 0) {
          existing.to = change.userAccount;
        } else {
          existing.from = change.userAccount;
        }
        perMint.set(mint, existing);
      }
    }

    for (const [mint, { from, to }] of perMint) {
      if (!from && !to) continue;
      if (from && to && from === to) continue;
      transfers.push({
        mintAddress: mint,
        fromWallet: from || '',
        toWallet: to || '',
        parserName: 'account_data_token_balances',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token program
      });
    }
    return transfers;
  },
};

export const PARSERS: Parser[] = [
  mplCoreTransferV1,
  mplCoreCreateV1,
  heliusEventsNft,
  splTokenTransfers,
  accountDataTokenBalances,
];

/**
 * Run all parsers against a single transaction, returning all unique transfers found.
 * Dedupes across parsers on (mintAddress, from, to) — if multiple parsers detect the
 * same transfer, the first one wins (registry order).
 */
export function runAllParsers(tx: any, ctx: ParserContext): ParsedTransfer[] {
  const seen = new Set<string>();
  const results: ParsedTransfer[] = [];
  for (const parser of PARSERS) {
    let transfersFromThisParser: ParsedTransfer[] = [];
    try {
      transfersFromThisParser = parser.run(tx, ctx);
    } catch {
      // parser failure shouldn't kill the whole tx; other parsers still run
      continue;
    }
    for (const t of transfersFromThisParser) {
      const key = `${t.mintAddress}:${t.fromWallet}:${t.toWallet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(t);
    }
  }
  return results;
}
