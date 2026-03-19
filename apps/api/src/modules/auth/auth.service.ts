import { Injectable, Inject, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { SiweMessage, generateNonce } from 'siwe';
import { createPublicClient, http, type Hex } from 'viem';
import { mainnet, base, abstract as abstractChain, polygon } from 'viem/chains';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, users, wallets } from '@nexus/database';
import { CHAIN_META } from '@nexus/types';

interface NonceRecord {
  nonce: string;
  expiresAt: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private nonceStore = new Map<string, NonceRecord>();

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  generateNonce(address: string): { nonce: string } {
    const nonce = generateNonce();
    this.nonceStore.set(address.toLowerCase(), {
      nonce,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    });
    return { nonce };
  }

  async verifyEvm(message: string, signature: string) {
    let siweMessage: SiweMessage;
    try {
      siweMessage = new SiweMessage(message);
    } catch {
      throw new UnauthorizedException('Malformed SIWE message');
    }

    const address = siweMessage.address.toLowerCase();

    const record = this.nonceStore.get(address);
    if (!record || record.expiresAt < Date.now()) {
      throw new UnauthorizedException('Nonce expired or not found. Request a new nonce.');
    }

    if (siweMessage.nonce !== record.nonce) {
      throw new UnauthorizedException('Invalid nonce');
    }

    // Use viem's verifyMessage which natively supports ERC-6492 signatures
    // from smart contract wallets (e.g. Coinbase Smart Wallet).
    // For ERC-6492 signatures, verify against Base where Coinbase Smart
    // Wallets live; otherwise use the chain from the SIWE message.
    const isErc6492 = signature.endsWith(
      '6492649264926492649264926492649264926492649264926492649264926492',
    );
    const verifyChainId = isErc6492 ? 8453 : (siweMessage.chainId ?? 1);
    const client = this.getViemClient(verifyChainId);

    this.logger.debug(
      `Verifying EVM signature: address=${siweMessage.address}, chainId=${verifyChainId}, isErc6492=${isErc6492}`,
    );

    let valid: boolean;
    try {
      valid = await client.verifyMessage({
        address: siweMessage.address as Hex,
        // Use the raw message string from the client — NOT prepareMessage() —
        // to avoid any round-trip mutations (timestamp format, whitespace)
        // that would change the message hash.
        message,
        signature: signature as Hex,
      });
    } catch (err) {
      this.logger.error(
        `Signature verification RPC error for ${siweMessage.address} on chain ${verifyChainId}`,
        err instanceof Error ? err.stack : err,
      );
      throw new UnauthorizedException('Signature verification failed');
    }

    if (!valid) {
      this.logger.warn(
        `Invalid signature for ${siweMessage.address} on chain ${verifyChainId} (isErc6492=${isErc6492})`,
      );
      throw new UnauthorizedException('Invalid signature');
    }

    this.nonceStore.delete(address);

    // Resolve chain from SIWE chainId — EVM wallets are interoperable
    // across chains but the wallet record tracks the chain the user signed from
    const chain = this.resolveEvmChain(siweMessage.chainId);
    const user = await this.findOrCreateUser(siweMessage.address, chain);
    const tokens = this.issueTokens(user.id, siweMessage.address, user.role);

    return { user, ...tokens };
  }

  async verifySolana(address: string, signature: string) {
    const record = this.nonceStore.get(address.toLowerCase());
    if (!record || record.expiresAt < Date.now()) {
      throw new UnauthorizedException('Nonce expired or not found. Request a new nonce.');
    }

    const message = `Sign this message to authenticate with NEXUS.\n\nNonce: ${record.nonce}`;
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = bs58.decode(address);

    const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
    if (!valid) {
      throw new UnauthorizedException('Invalid signature');
    }

    this.nonceStore.delete(address.toLowerCase());

    const user = await this.findOrCreateUser(address, 'solana');
    const tokens = this.issueTokens(user.id, address, user.role);

    return { user, ...tokens };
  }

  private getViemClient(chainId: number) {
    const chains: Record<number, Parameters<typeof createPublicClient>[0]['chain']> = {
      1: mainnet,
      8453: base,
      2741: abstractChain,
      137: polygon,
    };
    const chain = chains[chainId] ?? mainnet;

    const apiKey = this.config.get<string>('alchemy.apiKey');
    const resolvedChainName = this.resolveEvmChain(chainId);
    const meta = CHAIN_META[resolvedChainName as keyof typeof CHAIN_META];

    const transport =
      meta?.alchemySubdomain && apiKey
        ? http(`https://${meta.alchemySubdomain}.g.alchemy.com/v2/${apiKey}`)
        : http();

    return createPublicClient({ chain, transport });
  }

  private resolveEvmChain(chainId?: number): string {
    const idToChain: Record<number, string> = {
      1: 'ethereum',
      8453: 'base',
      2741: 'abstract',
      33139: 'apechain',
      137: 'polygon',
    };
    return idToChain[chainId ?? 1] ?? 'ethereum';
  }

  private async findOrCreateUser(address: string, chain: string) {
    const existingWallet = await this.db.query.wallets.findFirst({
      where: eq(wallets.address, address),
    });

    if (existingWallet?.userId) {
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, existingWallet.userId),
      });
      if (user) {
        await this.db
          .update(users)
          .set({ lastActiveAt: new Date() })
          .where(eq(users.id, user.id));
        return user;
      }
    }

    const [newUser] = await this.db.insert(users).values({}).returning();

    if (existingWallet) {
      await this.db
        .update(wallets)
        .set({ userId: newUser.id })
        .where(eq(wallets.id, existingWallet.id));
    } else {
      const [newWallet] = await this.db
        .insert(wallets)
        .values({ address, chain: chain as any, userId: newUser.id })
        .returning();
      await this.db
        .update(users)
        .set({ primaryWalletId: newWallet.id })
        .where(eq(users.id, newUser.id));
    }

    return newUser;
  }

  private issueTokens(userId: string, address: string, role = 'user') {
    const payload = { sub: userId, address, role };
    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken: this.jwtService.sign(payload, { expiresIn: '30d' }),
    };
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken);
      return this.issueTokens(payload.sub, payload.address, payload.role);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async getMe(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!user) throw new UnauthorizedException('User not found');

    const userWallets = await this.db.query.wallets.findMany({
      where: eq(wallets.userId, userId),
    });

    return { ...user, wallets: userWallets };
  }
}
