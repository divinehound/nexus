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
   * Auto-matches to an existing project by deployer address, or creates a new unverified project.
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
    let project = null;
    if (contractInfo.deployerAddress) {
      project = await this.db.query.projects.findFirst({
        where: sql`${contractInfo.deployerAddress} = ANY(${projects.deployerAddresses})`,
      });
    }

    // No deployer match — create a new unverified project
    if (!project) {
      const slug = await this.generateUniqueSlug(contractInfo.name);
      const deployerAddresses = contractInfo.deployerAddress
        ? [contractInfo.deployerAddress]
        : [];

      const [newProject] = await this.db
        .insert(projects)
        .values({
          name: contractInfo.name,
          slug,
          imageUrl: contractInfo.imageUrl,
          deployerAddresses,
          isVerified: false,
        })
        .returning();

      project = newProject;
    }

    // Insert the collection
    const [newCollection] = await this.db
      .insert(collections)
      .values({
        projectId: project.id,
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
   * Generate a unique slug from a name.
   */
  private async generateUniqueSlug(name: string): Promise<string> {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      || 'unknown';

    // Check if slug exists
    const existing = await this.db.query.projects.findFirst({
      where: eq(projects.slug, base),
    });

    if (!existing) return base;

    // Append random suffix
    const suffix = Math.random().toString(36).slice(2, 6);
    return `${base}-${suffix}`;
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
