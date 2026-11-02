import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  type Database,
  projects,
  collections,
  marketSnapshots,
} from '@nexus/database';
import { isContractAddress } from '@nexus/types';
import { BlockchainLookupService } from './blockchain-lookup.service';

@Injectable()
export class CollectionImportService {
  private readonly logger = new Logger(CollectionImportService.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly blockchainLookup: BlockchainLookupService,
  ) {}

  /**
   * Import a contract from the blockchain into the local database.
   * Auto-matches to an existing project by deployer address; otherwise the
   * collection has no project until an admin groups it into one.
   */
  async importCollection(contractAddress: string, chain: string) {
    if (!isContractAddress(contractAddress)) {
      throw new BadRequestException('Invalid contract address');
    }

    // Check if already exists
    const existing = await this.db.query.collections.findFirst({
      where: eq(collections.contractAddress, contractAddress),
      with: { project: true },
    });
    if (existing) {
      return { collection: existing, project: existing.project, alreadyExisted: true };
    }

    // Look up on-chain metadata
    const results = await this.blockchainLookup.lookup(contractAddress, chain);
    if (results.length === 0) {
      throw new BadRequestException(
        `Contract ${contractAddress} not found on ${chain || 'any chain'}`,
      );
    }

    const contractInfo = results[0];

    // Try to match to an existing project by deployer address
    const project = contractInfo.deployerAddress
      ? ((await this.db.query.projects.findFirst({
          where: sql`${contractInfo.deployerAddress} = ANY(${projects.deployerAddresses})`,
        })) ?? null)
      : null;

    // Insert the collection
    const [newCollection] = await this.db
      .insert(collections)
      .values({
        projectId: project?.id ?? null,
        contractAddress: contractInfo.contractAddress,
        chain: contractInfo.chain as any,
        name: contractInfo.name,
        imageUrl: contractInfo.imageUrl,
        supply: contractInfo.totalSupply,
        collectionType: contractInfo.tokenType as any,
      })
      .returning();

    // Fire-and-forget background enrichment
    void this.enrichCollection(newCollection.id, contractInfo.chain);

    return {
      collection: newCollection,
      project,
      alreadyExisted: false,
    };
  }

  /**
   * Background enrichment: fetch additional data and create initial market snapshot.
   */
  private async enrichCollection(
    collectionId: string,
    chain: string,
  ): Promise<void> {
    try {
      this.logger.log(`Starting enrichment for collection ${collectionId}`);

      // Create an initial market snapshot with whatever data we have
      await this.db.insert(marketSnapshots).values({
        collectionId,
        floorPrice: null,
        volume24h: null,
        holderCount: null,
        listedCount: null,
      });

      this.logger.log(`Enrichment complete for collection ${collectionId}`);
    } catch (err) {
      this.logger.error(`Enrichment failed for collection ${collectionId}: ${err}`);
    }
  }
}
