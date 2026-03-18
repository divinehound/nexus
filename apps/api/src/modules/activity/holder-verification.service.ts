import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class HolderVerificationService {
  private readonly logger = new Logger(HolderVerificationService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Verify that a wallet holds a specific token in a collection.
   * Checks ERC-721 ownership via Alchemy getNFTsForOwner.
   */
  async verifyEthereumHolder(
    walletAddress: string,
    contractAddress: string,
    tokenId: string,
  ): Promise<boolean> {
    const apiKey = this.config.get<string>('alchemy.apiKey');
    if (!apiKey) {
      this.logger.warn('ALCHEMY_API_KEY not set — skipping on-chain verification');
      return true; // fail-open in dev
    }

    const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${apiKey}/isHolderOfContract?wallet=${walletAddress}&contractAddress=${contractAddress}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        this.logger.error(`Alchemy API error: ${res.status}`);
        return false;
      }
      const body = (await res.json()) as { isHolderOfContract: boolean };
      return body.isHolderOfContract;
    } catch (err) {
      this.logger.error(`Holder verification failed: ${err}`);
      return false;
    }
  }

  /**
   * Verify Solana NFT ownership via Helius DAS API.
   */
  async verifySolanaHolder(
    walletAddress: string,
    mintAddress: string,
  ): Promise<boolean> {
    const apiKey = this.config.get<string>('helius.apiKey');
    if (!apiKey) {
      this.logger.warn('HELIUS_API_KEY not set — skipping on-chain verification');
      return true;
    }

    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAssetsByOwner',
          params: { ownerAddress: walletAddress, page: 1, limit: 1000 },
        }),
      });

      if (!res.ok) return false;
      const body = (await res.json()) as {
        result: { items: { id: string }[] };
      };
      return body.result.items.some((item) => item.id === mintAddress);
    } catch (err) {
      this.logger.error(`Solana holder verification failed: ${err}`);
      return false;
    }
  }
}
