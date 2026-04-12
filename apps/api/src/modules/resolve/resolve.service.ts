import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getFavoriteDomain, getAllDomains } from '@bonfida/spl-name-service';

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
    const connection = this.getSolanaConnection();
    if (!connection) {
      this.logger.warn('No Solana RPC configured — cannot resolve SNS');
      return null;
    }

    try {
      const owner = new PublicKey(address);

      // Try favorite domain first (fastest)
      try {
        const { reverse } = await getFavoriteDomain(connection, owner);
        if (reverse) return `${reverse}.sol`;
      } catch {
        // No favorite domain set — fall through to getAllDomains
      }

      // Fall back to listing all domains owned by this address
      try {
        const domains = await getAllDomains(connection, owner);
        if (domains.length > 0) {
          // Reverse-lookup the first domain's name account to get the human-readable name
          const { performReverseLookup } = await import(
            '@bonfida/spl-name-service'
          );
          const name = await performReverseLookup(connection, domains[0]);
          if (name) return `${name}.sol`;
        }
      } catch {
        // No domains found
      }

      return null;
    } catch (err) {
      this.logger.debug(`SNS resolve failed for ${address}: ${err}`);
      return null;
    }
  }
}
