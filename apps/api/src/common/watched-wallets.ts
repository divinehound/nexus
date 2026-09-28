import { and, eq } from 'drizzle-orm';
import { type Database, watchedWallets } from '@nexus/database';

export type WalletFamily = 'evm' | 'solana';

export function walletFamily(chain: string): WalletFamily {
  return chain === 'solana' ? 'solana' : 'evm';
}

/** EVM addresses are case-insensitive (stored lowercased); Solana's base58 is not. */
export function familyAddress(chain: string, address: string): string {
  return walletFamily(chain) === 'solana' ? address.trim() : address.trim().toLowerCase();
}

/**
 * Someone just proved they own this address (linked, moved or signed in with
 * it). Every watch-only copy goes — including the verifier's own, which the
 * verified wallet replaces — the same way a verified wallet moves between
 * accounts.
 */
export async function releaseWatchedWallet(db: Database, chain: string, address: string): Promise<void> {
  await db
    .delete(watchedWallets)
    .where(
      and(
        eq(watchedWallets.family, walletFamily(chain)),
        eq(watchedWallets.address, familyAddress(chain, address)),
      ),
    );
}
