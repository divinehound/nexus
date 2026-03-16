import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, wallets } from '@nexus/database';

@Injectable()
export class WalletsService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async connectWallet(address: string, chain: string) {
    // TODO: Implement SIWE verification, create user if needed, trigger holdings sync
    const existing = await this.db.query.wallets.findFirst({
      where: eq(wallets.address, address),
    });
    if (existing) return existing;

    const [wallet] = await this.db
      .insert(wallets)
      .values({ address, chain: chain as 'ethereum' | 'solana' })
      .returning();
    return wallet;
  }

  async getHoldings(address: string) {
    // TODO: Query holders table, group by project via collection→project join
    return [];
  }

  async getMyEvents(address: string) {
    // TODO: Aggregate events from all projects the wallet holds
    return [];
  }

  async getMyActivity(address: string) {
    // TODO: Aggregate activity from all projects the wallet holds
    return [];
  }
}
