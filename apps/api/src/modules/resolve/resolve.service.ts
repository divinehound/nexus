import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getFavoriteDomain, getAllDomains, performReverseLookup } from '@bonfida/spl-name-service';

/** Simple TTL cache for resolved domains. */
const cache = new Map<string, { domain: string | null; expiresAt: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class ResolveService {
  private readonly logger = new Logger(ResolveService.name);
  private solanaConnection: Connection | null = null;

  constructor(private readonly config: ConfigService) {}

  private getSolanaConnection(): Connection | null {
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
    return null;
  }

  async resolveSolanaDomain(address: string): Promise<string | null> {
    // Check cache first
    const cached = cache.get(address);
    if (cached && cached.expiresAt > Date.now()) return cached.domain;

    const connection = this.getSolanaConnection();
    if (!connection) {
      this.logger.warn('No Solana RPC configured — cannot resolve SNS');
      return null;
    }

    let domain: string | null = null;
    try {
      const owner = new PublicKey(address);

      // Try favorite domain first (fastest)
      try {
        const { reverse } = await getFavoriteDomain(connection, owner);
        if (reverse) domain = `${reverse}.sol`;
      } catch {
        // No favorite domain set — fall through to getAllDomains
      }

      // Fall back to listing all domains owned by this address
      if (!domain) {
        try {
          const domains = await getAllDomains(connection, owner);
          if (domains.length > 0) {
            const name = await performReverseLookup(connection, domains[0]);
            if (name) domain = `${name}.sol`;
          }
        } catch {
          // No domains found
        }
      }
    } catch (err) {
      this.logger.debug(`SNS resolve failed for ${address}: ${err}`);
    }

    // Cache the result (including nulls to avoid repeated lookups)
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

    // Resolve remaining addresses (sequentially to avoid RPC rate limits)
    for (const addr of toResolve) {
      results[addr] = await this.resolveSolanaDomain(addr);
    }

    return results;
  }
}
