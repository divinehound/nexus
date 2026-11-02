/**
 * Runs against a real Postgres with the migrations applied. Set
 * TEST_DATABASE_URL to a throwaway database to run it; it is skipped otherwise.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { createDatabase, collections, holderReports, projects } from '@nexus/database';
import { AdminProjectsService } from './admin-projects.service';
import { AdminService } from './admin.service';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('deleting projects (database)', () => {
  const db = createDatabase(url ?? 'postgres://unused');
  const service = new AdminProjectsService(db, {} as any);
  const admin = new AdminService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const run = `${Date.now()}`;
  let n = 0;
  const projectIds: string[] = [];
  const collectionIds: string[] = [];

  async function project(slug = `bulk-del-${run}-${n++}`) {
    const [p] = await db.insert(projects).values({ name: slug, slug }).returning();
    projectIds.push(p.id);
    return p;
  }

  async function collection(values: Partial<typeof collections.$inferInsert> = {}) {
    const [c] = await db
      .insert(collections)
      .values({
        chain: 'ethereum',
        contractAddress: `0x${run}${n++}`.padEnd(42, '0'),
        name: `Spam ${n}`,
        collectionType: 'erc721',
        ...values,
      })
      .returning();
    collectionIds.push(c.id);
    return c;
  }

  afterAll(async () => {
    if (collectionIds.length) await db.delete(collections).where(inArray(collections.id, collectionIds));
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
    await (db as any).$client.end();
  });

  it('deletes the projects and keeps their collections, unlinked', async () => {
    const a = await project();
    const b = await project();
    const keep = await project();
    const inA = await collection({ projectId: a.id, mappingStatus: 'mapped' });
    const inB = await collection({ projectId: b.id, mappingStatus: 'mapped' });
    const inKeep = await collection({ projectId: keep.id, mappingStatus: 'mapped' });
    const suggested = await collection({ proposedProjectId: a.id, mappingStatus: 'suggested', mappingConfidence: '0.900' });
    await db.insert(holderReports).values({ projectId: a.id, summary: {}, analysisVersion: 1 });

    const result = await service.deleteProjects([a.id, b.id, a.id]);

    expect(result.deleted.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(result.unlinkedCollections).toBe(2);
    expect(result.flaggedSpam).toBe(0);
    const left = await db.query.projects.findMany({ where: inArray(projects.id, [a.id, b.id, keep.id]) });
    expect(left.map((p) => p.id)).toEqual([keep.id]);

    const rows = await db.query.collections.findMany({
      where: inArray(collections.id, [inA.id, inB.id, inKeep.id, suggested.id]),
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(inA.id)).toMatchObject({ projectId: null, mappingStatus: 'unmapped', isSpam: false });
    expect(byId.get(inB.id)).toMatchObject({ projectId: null, mappingStatus: 'unmapped' });
    expect(byId.get(inKeep.id)).toMatchObject({ projectId: keep.id, mappingStatus: 'mapped' });
    expect(byId.get(suggested.id)).toMatchObject({
      proposedProjectId: null,
      mappingStatus: 'unmapped',
      mappingConfidence: null,
    });
    // Project-owned data goes with the project.
    expect(await db.query.holderReports.findFirst({ where: eq(holderReports.projectId, a.id) })).toBeUndefined();
  });

  it('flags the unlinked collections as spam when asked', async () => {
    const p = await project();
    const c = await collection({ projectId: p.id });
    const result = await service.deleteProjects([p.id], { markCollectionsSpam: true });
    expect(result.flaggedSpam).toBe(1);
    const row = await db.query.collections.findFirst({ where: eq(collections.id, c.id) });
    expect(row).toMatchObject({ projectId: null, isSpam: true, spamScore: 100, spamDetectedBy: 'manual' });
  });

  it('keeps the intake bucket and reports ids it did not find', async () => {
    let intake = await db.query.projects.findFirst({ where: eq(projects.slug, 'unassigned-contract-intake') });
    if (!intake) intake = await project('unassigned-contract-intake');
    const missing = '00000000-0000-4000-8000-000000000000';
    const result = await service.deleteProjects([intake.id, missing]);
    expect(result.deleted).toEqual([]);
    expect(result.skipped.map((s) => s.id)).toEqual([intake.id]);
    expect(result.notFound).toEqual([missing]);
    expect(await db.query.projects.findFirst({ where: eq(projects.id, intake.id) })).toBeDefined();
    await expect(service.deleteProject(intake.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deletes one project the same way, and 404s on an unknown one', async () => {
    const p = await project();
    const c = await collection({ projectId: p.id });
    await expect(service.deleteProject(p.id)).resolves.toEqual({ deleted: true, unlinkedCollections: 1 });
    expect(await db.query.collections.findFirst({ where: eq(collections.id, c.id) })).toMatchObject({ projectId: null });
    await expect(service.deleteProject(p.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects bad input', async () => {
    await expect(service.deleteProjects([])).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.deleteProjects('x')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.deleteProjects(['not-a-uuid'])).rejects.toBeInstanceOf(BadRequestException);
    const tooMany = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await expect(service.deleteProjects(tooMany)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists projects by filter and search', async () => {
    const auto = await project(`auto-ethereum-${run}`);
    const spam = await project();
    const empty = await project();
    await collection({ projectId: auto.id });
    await collection({ projectId: spam.id, isSpam: true });

    const ids = async (filter: string, q?: string) =>
      (await admin.listProjects(1, 100, { filter, q })).items.map((p) => p.id);

    expect(await ids('auto', run)).toEqual([auto.id]);
    expect(await ids('spam', run)).toEqual([spam.id]);
    expect(await ids('empty', run)).toContain(empty.id);
    expect(await ids('empty', run)).not.toContain(spam.id);
    const listed = await admin.listProjects(1, 100, { filter: 'spam', q: run });
    expect(listed.total).toBe(1);
    expect(listed.items[0].collections[0]).toMatchObject({ isSpam: true });
    await expect(admin.listProjects(1, 10, { filter: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
