import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gt,
  isNull,
  ne,
} from 'drizzle-orm';
import {
  type Database,
  users,
  wallets,
  walletLinkChallenges,
  walletMoveConfirmations,
  walletOwnershipMoves,
  walletNicknames,
  watchedWallets,
} from '@nexus/database';
import { ConfigService } from '@nestjs/config';
import { CHAIN_META } from '@nexus/types';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { randomBytes } from 'crypto';
import { createPublicClient, http, isAddress } from 'viem';
import { abstract, apeChain, base, mainnet, polygon } from 'viem/chains';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { HoldingsService } from '../holdings/holdings.service';
import { familyAddress, releaseWatchedWallet, walletFamily } from '../../common/watched-wallets';

/**
 * Chains a linking signature is checked on. A plain (EOA) signature is valid
 * on the first; smart-contract wallets (Abstract Global Wallet, Safe, Coinbase
 * Smart Wallet) only exist on some chains, so ERC-1271/6492 checks need the
 * chain the wallet lives on.
 */
const SIGNATURE_CHAINS = [
  { chain: mainnet, alchemy: CHAIN_META.ethereum?.alchemySubdomain },
  { chain: abstract, alchemy: CHAIN_META.abstract?.alchemySubdomain },
  { chain: base, alchemy: CHAIN_META.base?.alchemySubdomain },
  { chain: polygon, alchemy: CHAIN_META.polygon?.alchemySubdomain },
  { chain: apeChain, alchemy: CHAIN_META.apechain?.alchemySubdomain },
];
const MAX_WATCHED_WALLETS = 100;

@Injectable()
export class MeService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly holdingsService: HoldingsService,
    private readonly config: ConfigService,
  ) {}

  private formatWalletMessage(params: {
    purpose: 'link_wallet' | 'move_wallet';
    chain: string;
    address: string;
    nonce: string;
    confirmationToken?: string;
  }) {
    const lines = [
      'NEXUS Wallet Verification',
      `Purpose: ${params.purpose}`,
      `Chain: ${params.chain}`,
      `Address: ${params.address}`,
      `Nonce: ${params.nonce}`,
    ];

    if (params.confirmationToken) {
      lines.push(`Confirmation Token: ${params.confirmationToken}`);
    }

    return `${lines.join('\n')}\n`;
  }

  private decodeSolanaPublicKey(address: string): Uint8Array {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      throw new BadRequestException({ error: 'VALIDATION_ERROR', message: 'Invalid Solana wallet address' });
    }

    let decoded: Uint8Array;
    try {
      decoded = bs58.decode(address);
    } catch {
      throw new BadRequestException({ error: 'VALIDATION_ERROR', message: 'Invalid Solana wallet address' });
    }

    if (decoded.length !== 32 || bs58.encode(decoded) !== address) {
      throw new BadRequestException({ error: 'VALIDATION_ERROR', message: 'Invalid Solana wallet address' });
    }

    return decoded;
  }

  normalizeAndValidateAddress(chain: string, address: string): string {
    const value = address?.trim();
    if (!value) {
      throw new BadRequestException({ error: 'VALIDATION_ERROR', message: 'address is required' });
    }

    if (chain === 'solana') {
      this.decodeSolanaPublicKey(value);
      return value;
    }

    const normalized = value.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized) || !isAddress(normalized)) {
      throw new BadRequestException({ error: 'VALIDATION_ERROR', message: 'Invalid EVM wallet address' });
    }

    return normalized;
  }

  private abbreviateAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  private async verifyEvmSignature(address: string, message: string, signature: string) {
    const apiKey = this.config.get<string>('alchemy.apiKey');
    for (const { chain, alchemy } of SIGNATURE_CHAINS) {
      const transport = alchemy && apiKey ? http(`https://${alchemy}.g.alchemy.com/v2/${apiKey}`) : http();
      const client = createPublicClient({ chain, transport });
      try {
        const valid = await client.verifyMessage({
          address: address as `0x${string}`,
          message,
          signature: signature as `0x${string}`,
        });
        if (valid) return true;
      } catch {
        // RPC trouble on one chain shouldn't stop the others being tried.
      }
    }
    return false;
  }

  private verifySolanaSignature(address: string, message: string, signature: string): boolean {
    const publicKey = this.decodeSolanaPublicKey(address);

    let signatureBytes: Uint8Array;
    try {
      signatureBytes = bs58.decode(signature);
    } catch {
      throw new ForbiddenException({ error: 'INVALID_SIGNATURE', message: 'Signature could not be verified' });
    }

    if (signatureBytes.length !== 64) {
      throw new ForbiddenException({ error: 'INVALID_SIGNATURE', message: 'Signature could not be verified' });
    }

    const messageBytes = new TextEncoder().encode(message);
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey);
  }

  private preferredDisplayName(user: typeof users.$inferSelect, userWallets: (typeof wallets.$inferSelect)[]) {
    if (user.displayName) return user.displayName;

    const primaryWallet =
      userWallets.find((wallet) => wallet.id === user.primaryWalletId) ??
      userWallets.find((wallet) => wallet.isPrimary) ??
      userWallets[0];

    const ensName = primaryWallet?.ensName ?? userWallets.find((wallet) => wallet.ensName)?.ensName;
    if (ensName) return ensName;

    if (primaryWallet?.address) return this.abbreviateAddress(primaryWallet.address);

    return null;
  }

  async getMe(userId: string) {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new NotFoundException('User not found');

    const userWallets = await this.db.query.wallets.findMany({
      where: eq(wallets.userId, userId),
      orderBy: [desc(wallets.isPrimary), wallets.id],
    });

    return {
      ...user,
      displayName: this.preferredDisplayName(user, userWallets),
      wallets: userWallets,
    };
  }

  async updateProfile(userId: string, body: { email?: string; displayName?: string; avatarUrl?: string; bio?: string }) {
    const [updated] = await this.db
      .update(users)
      .set({
        email: body.email,
        displayName: body.displayName,
        avatarUrl: body.avatarUrl,
        bio: body.bio,
      })
      .where(eq(users.id, userId))
      .returning();

    if (!updated) throw new NotFoundException('User not found');

    return this.getMe(userId);
  }

  async createWalletChallenge(
    userId: string,
    body: { chain: string; address: string; purpose: 'link_wallet' | 'move_wallet'; confirmationToken?: string },
  ) {
    const chain = body.chain;
    const address = this.normalizeAndValidateAddress(chain, body.address);

    if (body.purpose === 'move_wallet') {
      if (!body.confirmationToken) {
        throw new BadRequestException({ error: 'VALIDATION_ERROR', message: 'confirmationToken is required for move_wallet' });
      }

      const confirmation = await this.db.query.walletMoveConfirmations.findFirst({
        where: and(
          eq(walletMoveConfirmations.toUserId, userId),
          eq(walletMoveConfirmations.chain, chain as any),
          eq(walletMoveConfirmations.address, address),
          eq(walletMoveConfirmations.token, body.confirmationToken),
          isNull(walletMoveConfirmations.usedAt),
          gt(walletMoveConfirmations.expiresAt, new Date()),
        ),
      });

      if (!confirmation) {
        throw new ForbiddenException({ error: 'INVALID_CONFIRMATION_TOKEN', message: 'Confirmation token is invalid or expired' });
      }
    }

    const nonce = randomBytes(16).toString('hex');
    const message = this.formatWalletMessage({
      purpose: body.purpose,
      chain,
      address,
      nonce,
      confirmationToken: body.purpose === 'move_wallet' ? body.confirmationToken : undefined,
    });

    await this.db.insert(walletLinkChallenges).values({
      userId,
      chain: chain as any,
      address,
      purpose: body.purpose,
      nonce,
      message,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    return { nonce, message };
  }

  async verifyWallet(userId: string, body: { chain: string; address: string; signature: string; message: string }) {
    const chain = body.chain;
    const address = this.normalizeAndValidateAddress(chain, body.address);

    const challenge = await this.db.query.walletLinkChallenges.findFirst({
      where: and(
        eq(walletLinkChallenges.userId, userId),
        eq(walletLinkChallenges.chain, chain as any),
        eq(walletLinkChallenges.address, address),
        eq(walletLinkChallenges.purpose, 'link_wallet'),
        eq(walletLinkChallenges.message, body.message),
        isNull(walletLinkChallenges.usedAt),
        gt(walletLinkChallenges.expiresAt, new Date()),
      ),
      orderBy: [desc(walletLinkChallenges.createdAt)],
    });

    if (!challenge) {
      throw new ForbiddenException({ error: 'INVALID_OR_EXPIRED_CHALLENGE', message: 'Challenge not found or expired' });
    }

    const validSignature = chain === 'solana'
      ? this.verifySolanaSignature(address, body.message, body.signature)
      : await this.verifyEvmSignature(address, body.message, body.signature);
    if (!validSignature) {
      throw new ForbiddenException({ error: 'INVALID_SIGNATURE', message: 'Signature could not be verified' });
    }

    const existingWallet = await this.db.query.wallets.findFirst({
      where: and(eq(wallets.chain, chain as any), eq(wallets.address, address)),
    });

    await this.db.update(walletLinkChallenges).set({ usedAt: new Date() }).where(eq(walletLinkChallenges.id, challenge.id));

    if (!existingWallet || !existingWallet.userId) {
      const ownedWallets = await this.db.query.wallets.findMany({ where: eq(wallets.userId, userId) });

      const [linked] = existingWallet
        ? await this.db
            .update(wallets)
            .set({ userId, isPrimary: ownedWallets.length === 0 })
            .where(eq(wallets.id, existingWallet.id))
            .returning()
        : await this.db
            .insert(wallets)
            .values({ chain: chain as any, address, userId, isPrimary: ownedWallets.length === 0 })
            .returning();

      if (ownedWallets.length === 0) {
        await this.db.update(users).set({ primaryWalletId: linked.id }).where(eq(users.id, userId));
      }
      await releaseWatchedWallet(this.db, chain, address);

      void this.holdingsService.queueWalletIndexing(userId, linked.id).catch(() => {
        // best-effort fire-and-forget
      });

      return { success: true, wallet: linked, moved: false };
    }

    if (existingWallet.userId === userId) {
      await releaseWatchedWallet(this.db, chain, address);
      void this.holdingsService.queueWalletIndexing(userId, existingWallet.id).catch(() => {
        // best-effort fire-and-forget
      });
      return { success: true, wallet: existingWallet, moved: false, idempotent: true };
    }

    const token = randomBytes(24).toString('hex');
    await this.db.insert(walletMoveConfirmations).values({
      walletId: existingWallet.id,
      fromUserId: existingWallet.userId,
      toUserId: userId,
      chain: chain as any,
      address,
      token,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    throw new ConflictException({
      error: 'WALLET_ALREADY_LINKED',
      message: 'Wallet is already linked to another user. Confirm transfer to move it.',
      confirmationToken: token,
    });
  }

  async moveWallet(
    userId: string,
    body: { chain: string; address: string; confirmationToken: string; signature: string; message: string },
  ) {
    const chain = body.chain;
    const address = this.normalizeAndValidateAddress(chain, body.address);

    const confirmation = await this.db.query.walletMoveConfirmations.findFirst({
      where: and(
        eq(walletMoveConfirmations.toUserId, userId),
        eq(walletMoveConfirmations.chain, chain as any),
        eq(walletMoveConfirmations.address, address),
        eq(walletMoveConfirmations.token, body.confirmationToken),
        isNull(walletMoveConfirmations.usedAt),
        gt(walletMoveConfirmations.expiresAt, new Date()),
      ),
      orderBy: [desc(walletMoveConfirmations.createdAt)],
    });

    if (!confirmation) {
      throw new ForbiddenException({ error: 'INVALID_CONFIRMATION_TOKEN', message: 'Confirmation token is invalid or expired' });
    }

    const challenge = await this.db.query.walletLinkChallenges.findFirst({
      where: and(
        eq(walletLinkChallenges.userId, userId),
        eq(walletLinkChallenges.chain, chain as any),
        eq(walletLinkChallenges.address, address),
        eq(walletLinkChallenges.purpose, 'move_wallet'),
        eq(walletLinkChallenges.message, body.message),
        isNull(walletLinkChallenges.usedAt),
        gt(walletLinkChallenges.expiresAt, new Date()),
      ),
      orderBy: [desc(walletLinkChallenges.createdAt)],
    });

    if (!challenge) {
      throw new ForbiddenException({ error: 'INVALID_OR_EXPIRED_CHALLENGE', message: 'Challenge not found or expired' });
    }

    const expectedPrefix = `Confirmation Token: ${body.confirmationToken}`;
    if (!body.message.includes(expectedPrefix)) {
      throw new ForbiddenException({ error: 'INVALID_MOVE_MESSAGE', message: 'Signed message must include confirmation token' });
    }

    const validSignature = chain === 'solana'
      ? this.verifySolanaSignature(address, body.message, body.signature)
      : await this.verifyEvmSignature(address, body.message, body.signature);
    if (!validSignature) {
      throw new ForbiddenException({ error: 'INVALID_SIGNATURE', message: 'Signature could not be verified' });
    }

    await this.db.update(walletLinkChallenges).set({ usedAt: new Date() }).where(eq(walletLinkChallenges.id, challenge.id));

    const movedWallet = await this.db.transaction(async (tx) => {
      const walletRow = await tx.query.wallets.findFirst({ where: eq(wallets.id, confirmation.walletId) });
      if (!walletRow) throw new NotFoundException('Wallet not found');

      const fromUserId = walletRow.userId;
      const destinationWalletCount = await tx.query.wallets.findMany({ where: eq(wallets.userId, userId) });

      const [updatedWallet] = await tx
        .update(wallets)
        .set({ userId, isPrimary: destinationWalletCount.length === 0 })
        .where(eq(wallets.id, walletRow.id))
        .returning();

      if (destinationWalletCount.length === 0) {
        await tx.update(users).set({ primaryWalletId: walletRow.id }).where(eq(users.id, userId));
      }

      if (fromUserId) {
        const fromUserWallets = await tx.query.wallets.findMany({ where: eq(wallets.userId, fromUserId) });
        const stillOwnsMovedWallet = fromUserWallets.some((wallet) => wallet.id === walletRow.id);

        if (!stillOwnsMovedWallet) {
          const replacementPrimary = fromUserWallets.find((wallet) => wallet.id !== walletRow.id);
          await tx
            .update(users)
            .set({ primaryWalletId: replacementPrimary?.id ?? null })
            .where(eq(users.id, fromUserId));

          if (walletRow.isPrimary && replacementPrimary) {
            await tx
              .update(wallets)
              .set({ isPrimary: true })
              .where(eq(wallets.id, replacementPrimary.id));
          }
        }
      }

      await tx
        .update(walletMoveConfirmations)
        .set({ usedAt: new Date() })
        .where(eq(walletMoveConfirmations.id, confirmation.id));

      await tx.insert(walletOwnershipMoves).values({
        walletId: updatedWallet.id,
        fromUserId: confirmation.fromUserId,
        toUserId: confirmation.toUserId,
        chain: updatedWallet.chain,
        address: updatedWallet.address,
        reason: 'user_confirmed_move',
      });

      return updatedWallet;
    });

    await releaseWatchedWallet(this.db, chain, address);
    void this.holdingsService.queueWalletIndexing(userId, movedWallet.id).catch(() => {
      // best-effort fire-and-forget
    });

    return { success: true, wallet: movedWallet, moved: true };
  }

  async getHoldingsSummary(userId: string) {
    return this.holdingsService.getMyHoldingsSummary(userId);
  }

  async getHoldingsCollections(
    userId: string,
    tier: 'active' | 'lightweight' | 'suppressed',
    page = 1,
    limit = 20,
  ) {
    if (!['active', 'lightweight', 'suppressed'].includes(tier)) {
      throw new BadRequestException({ error: 'VALIDATION_ERROR', message: 'Invalid tier value' });
    }

    return this.holdingsService.getMyHoldingsCollections(
      userId,
      tier,
      Number.isFinite(page) && page > 0 ? page : 1,
      Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20,
    );
  }

  async listWallets(userId: string) {
    return this.db.query.wallets.findMany({
      where: eq(wallets.userId, userId),
      orderBy: [desc(wallets.isPrimary), wallets.id],
    });
  }

  async setPrimaryWallet(userId: string, walletId: string) {
    const wallet = await this.db.query.wallets.findFirst({
      where: and(eq(wallets.id, walletId), eq(wallets.userId, userId)),
    });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    await this.db.transaction(async (tx) => {
      await tx.update(wallets).set({ isPrimary: false }).where(eq(wallets.userId, userId));
      await tx.update(wallets).set({ isPrimary: true }).where(eq(wallets.id, walletId));
      await tx.update(users).set({ primaryWalletId: walletId }).where(eq(users.id, userId));
    });

    return { success: true, primaryWalletId: walletId };
  }

  async deleteWallet(userId: string, walletId: string) {
    const userWallets = await this.db.query.wallets.findMany({ where: eq(wallets.userId, userId) });
    const wallet = userWallets.find((w) => w.id === walletId);

    if (!wallet) throw new NotFoundException('Wallet not found');

    if (userWallets.length <= 1) {
      throw new ForbiddenException({
        error: 'LAST_WALLET_DELETE_FORBIDDEN',
        message: 'Cannot remove your final wallet. Link another wallet first.',
      });
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(wallets).where(eq(wallets.id, walletId));

      if (wallet.isPrimary) {
        const replacement = await tx.query.wallets.findFirst({
          where: and(eq(wallets.userId, userId), ne(wallets.id, walletId)),
          orderBy: [wallets.id],
        });

        if (replacement) {
          await tx.update(wallets).set({ isPrimary: true }).where(eq(wallets.id, replacement.id));
          await tx.update(users).set({ primaryWalletId: replacement.id }).where(eq(users.id, userId));
        }
      }
    });

    return { success: true };
  }

  // ── Watch-only wallets ─────────────────────────────────────────────

  async listWatchedWallets(userId: string) {
    return this.db.query.watchedWallets.findMany({
      where: eq(watchedWallets.userId, userId),
      orderBy: [watchedWallets.createdAt],
    });
  }

  /**
   * Add an address without proving ownership. Only for the Money dashboard's
   * history — it never signs anyone in. An address someone has verified
   * can't be watched: it has to be verified (and moved) like any wallet.
   */
  async addWatchedWallet(userId: string, body: { family?: string; address?: string; label?: string | null }) {
    const family = body.family === 'solana' ? 'solana' : body.family === 'evm' ? 'evm' : null;
    if (!family) {
      throw new BadRequestException({ error: 'VALIDATION_ERROR', message: "family must be 'evm' or 'solana'" });
    }
    const chain = family === 'solana' ? 'solana' : 'ethereum';
    const address = familyAddress(chain, this.normalizeAndValidateAddress(chain, body.address ?? ''));
    const label = body.label?.trim().slice(0, 100) || null;

    const verified = await this.db.query.wallets.findMany({ where: eq(wallets.address, address) });
    const owner = verified.find((w) => walletFamily(w.chain) === family && w.userId);
    if (owner?.userId === userId) {
      throw new ConflictException({
        error: 'WALLET_ALREADY_VERIFIED',
        message: 'This wallet is already linked (verified) on your account.',
      });
    }
    if (owner) {
      throw new ConflictException({
        error: 'WALLET_LINKED_ELSEWHERE',
        message:
          'This wallet is verified on another account. To add it here, link it by signing with it — that moves it to your account.',
      });
    }

    const count = await this.db.query.watchedWallets.findMany({ where: eq(watchedWallets.userId, userId) });
    if (count.length >= MAX_WATCHED_WALLETS && !count.some((w) => w.family === family && w.address === address)) {
      throw new BadRequestException({
        error: 'TOO_MANY_WATCHED_WALLETS',
        message: `You can watch up to ${MAX_WATCHED_WALLETS} wallets.`,
      });
    }

    const [row] = await this.db
      .insert(watchedWallets)
      .values({ userId, family, address, label })
      .onConflictDoUpdate({
        target: [watchedWallets.userId, watchedWallets.family, watchedWallets.address],
        set: { label },
      })
      .returning();
    return row;
  }

  async removeWatchedWallet(userId: string, id: string) {
    const deleted = await this.db
      .delete(watchedWallets)
      .where(and(eq(watchedWallets.userId, userId), eq(watchedWallets.id, id)))
      .returning();
    if (deleted.length === 0) throw new NotFoundException('Watched wallet not found');
    return { success: true };
  }

  // ── Wallet Nicknames ───────────────────────────────────────────────

  async getNicknames(userId: string): Promise<Record<string, string>> {
    const rows = await this.db
      .select({ address: walletNicknames.address, nickname: walletNicknames.nickname })
      .from(walletNicknames)
      .where(eq(walletNicknames.userId, userId));

    const map: Record<string, string> = {};
    for (const r of rows) map[r.address] = r.nickname;
    return map;
  }

  async setNickname(
    userId: string,
    address: string,
    nickname: string | null,
  ): Promise<{ success: boolean }> {
    const addr = address.trim();
    if (!addr) throw new BadRequestException('address is required');

    // Empty or null nickname → delete
    if (!nickname || nickname.trim() === '') {
      await this.db
        .delete(walletNicknames)
        .where(
          and(
            eq(walletNicknames.userId, userId),
            eq(walletNicknames.address, addr),
          ),
        );
      return { success: true };
    }

    // Upsert nickname
    await this.db
      .insert(walletNicknames)
      .values({
        userId,
        address: addr,
        nickname: nickname.trim().slice(0, 100),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [walletNicknames.userId, walletNicknames.address],
        set: {
          nickname: nickname.trim().slice(0, 100),
          updatedAt: new Date(),
        },
      });

    return { success: true };
  }
}
