import { Injectable, Inject } from '@nestjs/common';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database } from '@nexus/database';

@Injectable()
export class DiscoveryService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async getRecommendations(walletAddress: string) {
    // TODO: Implement Tier 1 collaborative filtering
    // Find wallets sharing 2+ projects, surface their other projects
    return [];
  }

  async getEchoScore(walletAddress: string) {
    // TODO: Implement echo chamber score computation
    // Cluster projects, measure distribution of user's memberships
    return { walletAddress, echoScore: null, label: null };
  }
}
