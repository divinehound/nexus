import { Injectable, Inject, Logger } from '@nestjs/common';
import { ilike, or, eq, and, inArray } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, projects, collections } from '@nexus/database';
import { isContractAddress, type BlockchainContractInfo } from '@nexus/types';
import { BlockchainLookupService } from './blockchain-lookup.service';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly blockchainLookup: BlockchainLookupService,
  ) {}

  async search(query: string, chain?: string) {
    query = query.trim();
    const searchPattern = `%${query}%`;

    // Build collection query conditions
    const collectionNameOrAddress = or(
      ilike(collections.name, searchPattern),
      ilike(collections.contractAddress, searchPattern),
    );
    const collectionWhere = chain
      ? and(collectionNameOrAddress, eq(collections.chain, chain as any))
      : collectionNameOrAddress;

    const collectionResults = await this.db.query.collections.findMany({
      where: collectionWhere,
      limit: 10,
      with: { project: true },
    });

    // For projects: if chain is specified, only return projects that have
    // at least one collection on that chain
    const projectNameOrSlug = or(
      ilike(projects.name, searchPattern),
      ilike(projects.slug, searchPattern),
    );

    let projectResults: Awaited<ReturnType<typeof this.db.query.projects.findMany>>;
    if (chain) {
      // Find project IDs that have collections on this chain
      const projectIdsOnChain = await this.db
        .selectDistinct({ projectId: collections.projectId })
        .from(collections)
        .where(eq(collections.chain, chain as any));

      const ids = projectIdsOnChain.map((r) => r.projectId).filter((id): id is string => id !== null);
      if (ids.length > 0) {
        projectResults = await this.db.query.projects.findMany({
          where: and(projectNameOrSlug, inArray(projects.id, ids)),
          limit: 10,
          with: { collections: true },
        });
      } else {
        projectResults = [];
      }
    } else {
      projectResults = await this.db.query.projects.findMany({
        where: projectNameOrSlug,
        limit: 10,
        with: { collections: true },
      });
    }

    // If the query looks like a contract address and we have no local collection
    // matches, try blockchain lookup
    let blockchainResults: BlockchainContractInfo[] = [];
    const looksLikeAddress = isContractAddress(query);
    if (looksLikeAddress && collectionResults.length === 0) {
      this.logger.log(`No local match for address ${query}, trying blockchain lookup`);
      blockchainResults = await this.blockchainLookup.lookup(query, chain);
      this.logger.log(`Blockchain lookup returned ${blockchainResults.length} result(s)`);
    } else if (!looksLikeAddress && query.length >= 40) {
      this.logger.log(`Query "${query}" (len=${query.length}) did not pass isContractAddress check`);
    }

    return {
      projects: projectResults,
      collections: collectionResults,
      blockchainResults,
    };
  }
}
