/**
 * Runs against a real Postgres with the migrations applied. Set
 * TEST_DATABASE_URL to a throwaway database to run it; it is skipped otherwise.
 */
import { and, eq } from 'drizzle-orm';
import { createDatabase, users, wallets, walletHoldingsSnapshots, walletIndexingJobs } from '@nexus/database';
import { HoldingsService } from './holdings.service';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('wallet indexing when one chain fails (database)', () => {
  const db = createDatabase(url ?? 'postgres://unused');
  const userIds: string[] = [];
  const stamp = Date.now().toString(16);

  afterAll(async () => {
    for (const id of userIds) await db.delete(users).where(eq(users.id, id));
    await (db as any).$client.end();
  });

  async function setup(n: number) {
    const [user] = await db.insert(users).values({}).returning();
    userIds.push(user.id);
    const address = `0x${stamp}${n}`.padEnd(42, 'b').toLowerCase();
    const [wallet] = await db.insert(wallets).values({ userId: user.id, address, chain: 'ethereum' }).returning();
    const old = new Date(Date.now() - 86_400_000);
    await db.insert(walletHoldingsSnapshots).values([
      { userId: user.id, walletId: wallet.id, chain: 'robinhood', contractAddress: '0xkept', tokenCount: 1, lastSeenAt: old },
      { userId: user.id, walletId: wallet.id, chain: 'base', contractAddress: '0xsold', tokenCount: 1, lastSeenAt: old },
    ]);
    const [job] = await db.insert(walletIndexingJobs).values({ userId: user.id, walletId: wallet.id }).returning();
    return { wallet, job };
  }

  const service = (fetchWalletHoldings: (address: string, chain: string) => Promise<unknown>) =>
    new HoldingsService(db, { get: () => undefined } as any, {} as any, { fetchWalletHoldings } as any, {} as any);

  it('indexes the other chains and keeps the failed chain\'s holdings', async () => {
    const { wallet, job } = await setup(1);
    await service(async (_a, chain) => {
      if (chain === 'robinhood') throw new Error('Alchemy getNFTsForOwner error: 403');
      return { holdings: [], complete: true };
    }).runIndexingJob(job.id);

    const done = await db.query.walletIndexingJobs.findFirst({ where: eq(walletIndexingJobs.id, job.id) });
    expect(done).toMatchObject({ status: 'completed', statsJson: expect.objectContaining({ chainsFailed: ['robinhood'] }) });
    const rows = await db.query.walletHoldingsSnapshots.findMany({ where: and(eq(walletHoldingsSnapshots.walletId, wallet.id)) });
    expect(rows.map((r) => r.chain)).toEqual(['robinhood']);
  });

  it('fails the job when every chain fails', async () => {
    const { job } = await setup(2);
    await expect(
      service(async () => {
        throw new Error('Alchemy down');
      }).runIndexingJob(job.id),
    ).rejects.toThrow('Alchemy down');
    const failed = await db.query.walletIndexingJobs.findFirst({ where: eq(walletIndexingJobs.id, job.id) });
    expect(failed?.status).toBe('failed');
  });
});
