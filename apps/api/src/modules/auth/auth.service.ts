import { Injectable, Inject, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { SiweMessage, generateNonce } from 'siwe';
import { createPublicClient, http, hashMessage, encodeAbiParameters, concat, type Hex } from 'viem';
import { mainnet, base, abstract as abstractChain, polygon } from 'viem/chains';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, users, wallets } from '@nexus/database';
import { CHAIN_META } from '@nexus/types';

// Compiled bytecode of the ERC-6492 ValidateSigOffchain contract.
// Deploys a UniversalSigValidator in-memory via eth_call to verify any
// signature type: EOA (ecrecover), ERC-1271, and ERC-6492.
// Source: https://eips.ethereum.org/EIPS/eip-6492
const ERC6492_UNIVERSAL_VALIDATOR: Hex = '0x608060405234801561000f575f5ffd5b506040516106fb3803806106fb83398101604081905261002e91610559565b5f61003a848484610045565b9050805f526001601ff35b5f5f846001600160a01b0316803b806020016040519081016040528181525f908060200190933c90507f649264926492649264926492649264926492649264926492649264926492649261009884610470565b036101f9575f606080858060200190518101906100b591906105ae565b865192955090935091505f03610174575f836001600160a01b0316836040516100de919061060f565b5f604051808303815f865af19150503d805f8114610117576040519150601f19603f3d011682016040523d82523d5f602084013e61011c565b606091505b50509050806101725760405162461bcd60e51b815260206004820152601e60248201527f5369676e617475726556616c696461746f723a206465706c6f796d656e74000060448201526064015b60405180910390fd5b505b604051630b135d3f60e11b808252906001600160a01b038a1690631626ba7e906101a4908b908690600401610625565b602060405180830381865afa1580156101bf573d5f5f3e3d5ffd5b505050506040513d601f19601f820116820180604052508101906101e39190610661565b6001600160e01b03191614945050505050610469565b8051156102e3575f5f866001600160a01b0316631626ba7e60e01b8787604051602401610227929190610625565b60408051601f198184030181529181526020820180516001600160e01b03166001600160e01b0319909416939093179092529051610265919061060f565b5f60405180830381855afa9150503d805f811461029d576040519150601f19603f3d011682016040523d82523d5f602084013e6102a2565b606091505b50915091508180156102b5575080516020145b156102e057630b135d3f60e11b6102cb82610688565b6001600160e01b031916149350505050610469565b50505b82516041146103475760405162461bcd60e51b815260206004820152603a60248201525f5160206106db5f395f51905f5260448201527f3a20696e76616c6964207369676e6174757265206c656e6774680000000000006064820152608401610169565b61034f610487565b50602083015160408085015185518693925f918591908110610373576103736106c6565b016020015160f81c9050601b811480159061039257508060ff16601c14155b156103f25760405162461bcd60e51b815260206004820152603b60248201525f5160206106db5f395f51905f5260448201527f3a20696e76616c6964207369676e617475726520762076616c756500000000006064820152608401610169565b604080515f8152602081018083528a905260ff83169181019190915260608101849052608081018390526001600160a01b038a169060019060a0016020604051602081039080840390855afa15801561044d573d5f5f3e3d5ffd5b505050602060405103516001600160a01b031614955050505050505b9392505050565b5f60208251101561047f575f5ffd5b508051015190565b60405180606001604052806003906020820280368337509192915050565b6001600160a01b03811681146104b9575f5ffd5b50565b634e487b7160e01b5f52604160045260245ffd5b5f82601f8301126104df575f5ffd5b81516001600160401b038111156104f8576104f86104bc565b604051601f8201601f19908116603f011681016001600160401b0381118282101715610526576105266104bc565b60405281815283820160200185101561053d575f5ffd5b8160208501602083015e5f918101602001919091529392505050565b5f5f5f6060848603121561056b575f5ffd5b8351610576816104a5565b6020850151604086015191945092506001600160401b03811115610598575f5ffd5b6105a4868287016104d0565b9150509250925092565b5f5f5f606084860312156105c0575f5ffd5b83516105cb816104a5565b60208501519093506001600160401b038111156105e6575f5ffd5b6105f2868287016104d0565b604086015190935090506001600160401b03811115610598575f5ffd5b5f82518060208501845e5f920191825250919050565b828152604060208201525f82518060408401528060208501606085015e5f606082850101526060601f19601f8301168401019150509392505050565b5f60208284031215610671575f5ffd5b81516001600160e01b031981168114610469575f5ffd5b805160208201516001600160e01b03198116919060048210156106bf576001600160e01b0319600483900360031b81901b82161692505b5050919050565b634e487b7160e01b5f52603260045260245ffdfe5369676e617475726556616c696461746f72237265636f7665725369676e6572';

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

    // Detect ERC-6492 signatures from smart contract wallets (e.g. Coinbase
    // Smart Wallet with passkeys). Always verify on the chain from the SIWE
    // message — the wallet's replaySafeHash uses block.chainid in its EIP-712
    // domain separator, so the verification chain must match the signing chain.
    // ERC-6492 handles deploying the wallet on any chain during eth_call.
    const isErc6492 = signature.endsWith(
      '6492649264926492649264926492649264926492649264926492649264926492',
    );
    const verifyChainId = siweMessage.chainId ?? 1;
    const client = this.getViemClient(verifyChainId);

    this.logger.log(
      `Verifying EVM signature: address=${siweMessage.address}, chainId=${verifyChainId}, isErc6492=${isErc6492}`,
    );

    let valid: boolean;
    if (isErc6492) {
      valid = await this.verifyErc6492Signature(
        client,
        siweMessage.address as Hex,
        message,
        signature as Hex,
      );
    } else {
      try {
        valid = await client.verifyMessage({
          address: siweMessage.address as Hex,
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

  /**
   * Verify an ERC-6492 signature by making a raw eth_call with the
   * ERC-6492 UniversalSigValidator bytecode. This bypasses viem's
   * verifyMessage which silently swallows CallExecutionErrors, making
   * it impossible to diagnose failures.
   *
   * Source: https://eips.ethereum.org/EIPS/eip-6492
   */
  private async verifyErc6492Signature(
    client: ReturnType<typeof createPublicClient>,
    address: Hex,
    message: string,
    signature: Hex,
  ): Promise<boolean> {
    const hash = hashMessage(message);

    // Encode constructor args: (address signer, bytes32 hash, bytes signature)
    const constructorArgs = encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes' },
      ],
      [address, hash, signature],
    );

    // Concatenate validator bytecode + constructor args for deployless eth_call
    const callData = concat([ERC6492_UNIVERSAL_VALIDATOR, constructorArgs]);

    try {
      const result = await client.call({ data: callData });
      return result.data === '0x01';
    } catch (err) {
      // Log the full error — this is what viem silently swallows
      this.logger.error(
        `ERC-6492 eth_call reverted for ${address}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (err instanceof Error && err.stack) {
        this.logger.error(err.stack);
      }
      return false;
    }
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
