import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  type Database,
  collections,
  collectionIntakeRequests,
  projects,
} from '@nexus/database';

const SUPPORTED_CHAINS = [
  'ethereum',
  'base',
  'abstract',
  'apechain',
  'polygon',
  'solana',
] as const;

type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

@Injectable()
export class CollectionsService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async findById(id: string) {
    return this.db.query.collections.findFirst({
      where: eq(collections.id, id),
      with: { project: true, marketSnapshots: true, proposedProject: true },
    });
  }

  async findByAddress(address: string) {
    return this.db.query.collections.findFirst({
      where: eq(collections.contractAddress, address),
      with: { project: true, proposedProject: true },
    });
  }

  async trackCollection(input: { chain: string; contractAddress: string }) {
    const chain = this.validateChain(input.chain);
    const normalizedAddress = this.normalizeAndValidateAddress(
      chain,
      input.contractAddress,
    );

    const intakeProjectId = await this.ensureUnassignedProject();

    const [trackedCollection] = await this.db
      .insert(collections)
      .values({
        projectId: intakeProjectId,
        chain,
        contractAddress: normalizedAddress,
        name: this.defaultCollectionName(chain, normalizedAddress),
        collectionType: chain === 'solana' ? 'spl' : 'erc721',
        verificationStatus: 'tracked_unverified',
        mappingStatus: 'unmapped',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [collections.chain, collections.contractAddress],
        set: {
          lastSeenAt: new Date(),
          verificationStatus: 'tracked_unverified',
        },
      })
      .returning();

    await this.db.insert(collectionIntakeRequests).values({
      chain,
      contractAddress: normalizedAddress,
      source: 'api',
      status: 'queued',
    });

    return {
      collectionId: trackedCollection.id,
      status: trackedCollection.verificationStatus,
      routeHint: `/api/collections/${chain}/${normalizedAddress}`,
    };
  }

  async findByChainAndContract(chainInput: string, contractAddressInput: string) {
    const chain = this.validateChain(chainInput);
    const contractAddress = this.normalizeAndValidateAddress(
      chain,
      contractAddressInput,
    );

    const collection = await this.db.query.collections.findFirst({
      where: and(
        eq(collections.chain, chain),
        eq(collections.contractAddress, contractAddress),
      ),
      with: {
        project: true,
        proposedProject: true,
      },
    });

    if (!collection) {
      throw new NotFoundException({
        error: 'NOT_FOUND',
        message: 'Collection not tracked',
      });
    }

    return {
      id: collection.id,
      chain: collection.chain,
      contractAddress: collection.contractAddress,
      name: collection.name,
      imageUrl: collection.imageUrl,
      collectionType: collection.collectionType,
      verificationStatus: collection.verificationStatus,
      mappingStatus: collection.mappingStatus,
      verificationNotes: collection.verificationNotes,
      mappingConfidence:
        collection.mappingConfidence === null
          ? null
          : Number(collection.mappingConfidence),
      firstSeenAt: collection.firstSeenAt,
      lastSeenAt: collection.lastSeenAt,
      project: collection.project
        ? {
            id: collection.project.id,
            name: collection.project.name,
            slug: collection.project.slug,
            isVerified: collection.project.isVerified,
          }
        : null,
      proposedProject: collection.proposedProject
        ? {
            id: collection.proposedProject.id,
            name: collection.proposedProject.name,
            slug: collection.proposedProject.slug,
            isVerified: collection.proposedProject.isVerified,
          }
        : null,
      metrics: {
        floorPrice: collection.floorPrice,
        holderCount: collection.holderCount,
        listedCount: collection.listedCount,
        volume24h: null,
      },
    };
  }

  validateChain(chain: string): SupportedChain {
    if (!SUPPORTED_CHAINS.includes(chain as SupportedChain)) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `Unsupported chain: ${chain}`,
      });
    }
    return chain as SupportedChain;
  }

  normalizeAndValidateAddress(chain: SupportedChain, address: string): string {
    const value = address?.trim();
    if (!value) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'contractAddress is required',
      });
    }

    if (chain === 'solana') {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
        throw new BadRequestException({
          error: 'VALIDATION_ERROR',
          message: 'Invalid Solana contract address',
        });
      }
      return value;
    }

    const normalized = value.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'Invalid EVM contract address',
      });
    }
    return normalized;
  }

  private defaultCollectionName(chain: SupportedChain, address: string): string {
    return `${chain}:${address.slice(0, 8)}...`;
  }

  private async ensureUnassignedProject(): Promise<string> {
    const slug = 'unassigned-contract-intake';

    const existing = await this.db.query.projects.findFirst({
      where: eq(projects.slug, slug),
    });
    if (existing) return existing.id;

    const [created] = await this.db
      .insert(projects)
      .values({
        name: 'Unassigned Contract Intake',
        slug,
        description:
          'Auto-generated placeholder project for contract-first intake before project mapping.',
        isVerified: false,
      })
      .returning();

    return created.id;
  }
}
