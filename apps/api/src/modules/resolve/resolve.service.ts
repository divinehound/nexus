import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  getFavoriteDomain,
  getMultipleFavoriteDomains,
} from '@bonfida/spl-name-service';

/** Simple TTL cache for resolved domains. */
const cache = new Map<string, { domain: string | null; expiresAt: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class ResolveService {
  private readonly logger = new Logger(ResolveService.name);
  private solanaConnection: Connection | null = null;

  constructor(private readonly config: ConfigService) {}

  private getSolanaConnection(): Connection {
    if (this.solanaConnection) return this.solanaConnection;

    const explicit = this.config.get<string>('solana.rpcUrl');
    if (explicit) {
      this.solanaConnection = new Connection(explicit);
      return this.solanaConnection;
    }
    const heliusKey = this.config.get<string>('HELIUS_API_KEY');
    if (heliusKey) {
      this.solanaConnection = new Connection(
        `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
      );
      return this.solanaConnection;
    }
    // Fallback to public RPC (rate-limited but functional)
    this.solanaConnection = new Connection(
      'https://api.mainnet-beta.solana.com',
    );
    return this.solanaConnection;
  }

  async resolveSolanaDomain(address: string): Promise<string | null> {
    // Check cache first
    const cached = cache.get(address);
    if (cached && cached.expiresAt > Date.now()) return cached.domain;

    const connection = this.getSolanaConnection();
    let domain: string | null = null;

    try {
      const owner = new PublicKey(address);
      const { reverse } = await getFavoriteDomain(connection, owner);
      if (reverse) domain = `${reverse}.sol`;
    } catch {
      // No favorite domain or RPC error
    }

    cache.set(address, { domain, expiresAt: Date.now() + CACHE_TTL });
    return domain;
  }

  async resolveBatch(
    addresses: string[],
  ): Promise<Record<string, string | null>> {
    const results: Record<string, string | null> = {};
    const toResolve: string[] = [];

    // Check cache first for all addresses
    for (const addr of addresses) {
      const cached = cache.get(addr);
      if (cached && cached.expiresAt > Date.now()) {
        results[addr] = cached.domain;
      } else {
        toResolve.push(addr);
      }
    }

    if (toResolve.length === 0) return results;

    // Use getMultipleFavoriteDomains for efficient batch resolution
    // (only a few RPC calls for all addresses instead of 2-3 per address)
    const connection = this.getSolanaConnection();
    try {
      const pubkeys = toResolve.map((addr) => new PublicKey(addr));
      const domains = await getMultipleFavoriteDomains(connection, pubkeys);

      for (let i = 0; i < toResolve.length; i++) {
        const domain = domains[i] ? `${domains[i]}.sol` : null;
        results[toResolve[i]] = domain;
        cache.set(toResolve[i], {
          domain,
          expiresAt: Date.now() + CACHE_TTL,
        });
      }
    } catch (err) {
      this.logger.warn(`Batch SNS resolve failed: ${err}`);
      // On failure, cache all as null to avoid retrying immediately
      for (const addr of toResolve) {
        results[addr] = null;
        cache.set(addr, { domain: null, expiresAt: Date.now() + CACHE_TTL });
      }
    }

    return results;
  }
}
