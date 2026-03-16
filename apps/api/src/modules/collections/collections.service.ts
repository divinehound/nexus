import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, collections } from '@nexus/database';

@Injectable()
export class CollectionsService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async findById(id: string) {
    return this.db.query.collections.findFirst({
      where: eq(collections.id, id),
      with: { project: true, marketSnapshots: true },
    });
  }

  async findByAddress(address: string) {
    return this.db.query.collections.findFirst({
      where: eq(collections.contractAddress, address),
      with: { project: true },
    });
  }
}
