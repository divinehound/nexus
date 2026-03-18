import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { SiweMessage, generateNonce } from 'siwe';
import { JsonRpcProvider } from 'ethers';
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

    // Build an ethers provider so SIWE can fall back to ERC-1271
    // on-chain verification for smart-contract wallets (e.g. Coinbase Smart Wallet).
    const provider = this.getEvmProvider(siweMessage.chainId);

    const result = await siweMessage.verify({ signature, provider });
    if (!result.success) {
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

  private getEvmProvider(chainId?: number): JsonRpcProvider {
    const chain = this.resolveEvmChain(chainId);
    const meta = CHAIN_META[chain as keyof typeof CHAIN_META];
    const apiKey = this.config.get<string>('alchemy.apiKey');

    if (meta?.alchemySubdomain && apiKey) {
      return new JsonRpcProvider(
        `https://${meta.alchemySubdomain}.g.alchemy.com/v2/${apiKey}`,
      );
    }

    // Fallback to public RPC for chains without Alchemy support
    const publicRpcs: Record<number, string> = {
      1: 'https://eth.llamarpc.com',
      8453: 'https://mainnet.base.org',
      137: 'https://polygon-rpc.com',
      2741: 'https://api.abstractions.io',
      33139: 'https://rpc.apechain.com',
    };
    return new JsonRpcProvider(publicRpcs[chainId ?? 1] ?? 'https://eth.llamarpc.com');
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
