/**
 * Runs against a real Postgres with the migrations applied. Set
 * TEST_DATABASE_URL to a throwaway database to run it; it is skipped otherwise.
 */
import { count, eq, inArray } from 'drizzle-orm';
import { createDatabase, collections, projects } from '@nexus/database';
import { HoldingsService } from './holdings.service';
import { CollectionImportService } from '../search/collection-import.service';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('new collections get no project of their own (database)', () => {
  const db = createDatabase(url ?? 'postgres://unused');
  const created: string[] = [];
  const createdProjects: string[] = [];
  const stamp = Date.now().toString(16);
  const address = (n: number) => `0x${stamp}${n}`.padEnd(42, 'a').toLowerCase();
  const lookup = (contractAddress: string, deployerAddress?: string) => ({
    lookup: async () => [
      { contractAddress, chain: 'ethereum', name: 'Wallet Thing', tokenType: 'erc721', totalSupply: 10, deployerAddress },
    ],
  });
  const projectCount = async () => (await db.select({ n: count() }).from(projects))[0].n;

  afterAll(async () => {
    if (created.length) await db.delete(collections).where(inArray(collections.id, created));
    if (createdProjects.length) await db.delete(projects).where(inArray(projects.id, createdProjects));
    await (db as any).$client.end();
  });

  it('wallet holdings intake tracks a new contract without creating a project', async () => {
    const contract = address(1);
    const holdings = new HoldingsService(db, { get: () => undefined } as any, lookup(contract) as any, {} as any, {} as any);
    const before = await projectCount();
    const row = await (holdings as any).ensureCollection('ethereum', contract, { tier: 'lightweight', score: 40, reason: 'x' });
    created.push(row.id);
    expect(row).toMatchObject({ projectId: null, name: 'Wallet Thing', mappingStatus: 'unmapped' });
    expect(await projectCount()).toBe(before);
  });

  it('importing a contract joins the deployer\'s project, or no project', async () => {
    const deployer = address(9);
    const [owner] = await db
      .insert(projects)
      .values({ name: `Deployer ${stamp}`, slug: `deployer-${stamp}`, deployerAddresses: [deployer] })
      .returning();
    createdProjects.push(owner.id);
    const before = await projectCount();

    const known = address(2);
    const a = await new CollectionImportService(db, lookup(known, deployer) as any).importCollection(known, 'ethereum');
    created.push(a.collection.id);
    expect(a.project?.id).toBe(owner.id);

    const unknown = address(3);
    const b = await new CollectionImportService(db, lookup(unknown, address(8)) as any).importCollection(unknown, 'ethereum');
    created.push(b.collection.id);
    expect(b.project).toBeNull();
    const row = await db.query.collections.findFirst({ where: eq(collections.id, b.collection.id) });
    expect(row?.projectId).toBeNull();
    expect(await projectCount()).toBe(before);
  });

  it('stores an imported EVM address lowercase and finds it again in any case', async () => {
    const lower = address(4);
    const mixed = `0x${lower.slice(2).toUpperCase()}`;
    const service = new CollectionImportService(db, lookup(mixed) as any);
    const first = await service.importCollection(mixed, 'ethereum');
    created.push(first.collection.id);
    expect(first.collection.contractAddress).toBe(lower);
    const again = await service.importCollection(mixed, 'ethereum');
    expect(again).toMatchObject({ alreadyExisted: true, collection: { id: first.collection.id } });
  });
});
