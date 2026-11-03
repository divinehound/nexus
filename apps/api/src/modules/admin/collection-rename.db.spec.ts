/**
 * Runs against a real Postgres with the migrations applied. Set
 * TEST_DATABASE_URL to a throwaway database to run it; it is skipped otherwise.
 */
import { BadRequestException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { createDatabase, collections, projects } from '@nexus/database';
import { AdminService } from './admin.service';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('renaming collections (database)', () => {
  const db = createDatabase(url ?? 'postgres://unused');
  const lookup = jest.fn();
  const admin = new AdminService(db, {} as any, {} as any, { lookup } as any, {} as any, {} as any, {} as any, {} as any);
  const run = `${Date.now()}`;
  let n = 0;
  const collectionIds: string[] = [];
  const projectIds: string[] = [];

  async function collection(values: Partial<typeof collections.$inferInsert> = {}) {
    const [c] = await db
      .insert(collections)
      .values({
        chain: 'ethereum',
        contractAddress: `0x${run}${n++}`.padEnd(42, 'a'),
        name: 'Synced Name',
        collectionType: 'erc721',
        ...values,
      })
      .returning();
    collectionIds.push(c.id);
    return c;
  }

  const row = async (id: string) => (await db.query.collections.findFirst({ where: eq(collections.id, id) }))!;

  beforeEach(() => {
    lookup.mockReset();
    lookup.mockResolvedValue([{ name: 'Chain Name', imageUrl: 'https://img', totalSupply: 10, tokenType: 'erc721' }]);
  });

  afterAll(async () => {
    if (collectionIds.length) await db.delete(collections).where(inArray(collections.id, collectionIds));
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
    await (db as any).$client.end();
  });

  it('keeps an admin rename when metadata is refreshed', async () => {
    const c = await collection();
    const detail = await admin.updateCollection(c.id, { name: '  Spooky Boys  ' });
    expect(detail.name).toBe('Spooky Boys');
    expect(detail.nameEditedAt).toBeInstanceOf(Date);

    await admin.enrichCollection(c.id);
    const after = await row(c.id);
    expect(after.name).toBe('Spooky Boys');
    expect(after.imageUrl).toBe('https://img');
    expect(after.supply).toBe(10);
  });

  it('still takes the chain name for collections nobody renamed', async () => {
    const c = await collection();
    await admin.enrichCollection(c.id);
    expect((await row(c.id)).name).toBe('Chain Name');
  });

  it('names an auto project after the admin name, not the chain name', async () => {
    const slug = `auto-rename-${run}`;
    const [p] = await db.insert(projects).values({ name: 'Auto 0xabc', slug }).returning();
    projectIds.push(p.id);
    const c = await collection({ projectId: p.id });
    await admin.updateCollection(c.id, { name: 'Admin Name' });
    await admin.enrichCollection(c.id);
    expect((await db.query.projects.findFirst({ where: eq(projects.id, p.id) }))!.name).toBe('Admin Name');
  });

  it('keeps a rename made while the metadata lookup is running', async () => {
    const c = await collection();
    lookup.mockImplementation(async () => {
      await admin.updateCollection(c.id, { name: 'Renamed Mid-Lookup' });
      return [{ name: 'Chain Name', imageUrl: null, totalSupply: 1, tokenType: 'erc721' }];
    });
    await admin.enrichCollection(c.id);
    expect(await row(c.id)).toMatchObject({ name: 'Renamed Mid-Lookup' });
  });

  it('a rename also renames an auto-created project right away', async () => {
    const [p] = await db.insert(projects).values({ name: 'Auto 0xdef', slug: `auto-direct-${run}` }).returning();
    projectIds.push(p.id);
    const c = await collection({ projectId: p.id });
    await admin.updateCollection(c.id, { name: 'Direct Name' });
    expect((await db.query.projects.findFirst({ where: eq(projects.id, p.id) }))!.name).toBe('Direct Name');
  });

  it('reset drops the rename and takes the chain name again', async () => {
    const c = await collection();
    await admin.updateCollection(c.id, { name: 'Custom' });
    const result = await admin.resetCollectionName(c.id);
    expect(result.refreshed).toBe(true);
    expect(result.collection).toMatchObject({ name: 'Chain Name', nameEditedAt: null });
  });

  it('reset keeps the current name when the lookup finds nothing', async () => {
    const c = await collection();
    await admin.updateCollection(c.id, { name: 'Custom' });
    lookup.mockResolvedValue([]);
    const result = await admin.resetCollectionName(c.id);
    expect(result.refreshed).toBe(false);
    expect(result.collection).toMatchObject({ name: 'Custom', nameEditedAt: null });
  });

  it('saving the same name does not mark it as an admin edit', async () => {
    const c = await collection();
    const detail = await admin.updateCollection(c.id, { name: 'Synced Name', description: ' About ' });
    expect(detail.nameEditedAt).toBeNull();
    expect(detail.description).toBe('About');
  });

  it('rejects blank names and ignores fields that are not editable', async () => {
    const c = await collection();
    await expect(admin.updateCollection(c.id, { name: '   ' })).rejects.toThrow(BadRequestException);
    await admin.updateCollection(c.id, { isSpam: true, projectId: null, websiteUrl: '' } as any);
    expect(await row(c.id)).toMatchObject({ isSpam: false, websiteUrl: null });
  });
});
