import { kindFor } from './holder-analysis.service';
import { HolderAnalysisSyncCron } from './sync.processor';

const ZERO = '0x0000000000000000000000000000000000000000';
const W = '0x00000000000000000000000000000000000000a1';
const O = '0x00000000000000000000000000000000000000b2';
const STAKE = '0x00000000000000000000000000000000000000c3';
const t = (from: string, to: string, value: string | null = null) => ({ from_address: from, to_address: to, tx_value: value });

describe('holder analysis', () => {
  it('names what a transfer was for the wallet', () => {
    expect(kindFor(W, t(ZERO, W), [])).toBe('minted');
    expect(kindFor(W, t(O, W, '1000'), [])).toBe('bought');
    expect(kindFor(W, t(O, W, '0'), [])).toBe('received');
    expect(kindFor(W, t(W, O, '1000'), [])).toBe('sold');
    expect(kindFor(W, t(W, O), [])).toBe('sent');
    expect(kindFor(W, t(W, '0x000000000000000000000000000000000000dead'), [])).toBe('burned');
    expect(kindFor(W, t(W, STAKE), [STAKE])).toBe('staked');
    expect(kindFor(W, t(STAKE, W), [STAKE])).toBe('unstaked');
    expect(kindFor(W, t(W, W), [])).toBe('self');
  });

  it('queues a project analysis unless one is already waiting, even while one runs', async () => {
    const jobs: { name: string; data: { projectId?: string }; state: string }[] = [];
    const queue = {
      getJobs: async (states: string[]) => jobs.filter((j) => states.includes(j.state)),
      add: async (name: string, data: { projectId?: string }) => jobs.push({ name, data, state: 'waiting' }),
    };
    const cron = new HolderAnalysisSyncCron(queue as any);
    expect(await cron.enqueueAnalysis('p1')).toBe(true);
    expect(await cron.enqueueAnalysis('p1')).toBe(false);
    expect(await cron.enqueueAnalysis('p2')).toBe(true);
    jobs[0].state = 'active'; // it may have read the labels already: a change queues another
    expect(await cron.enqueueAnalysis('p1')).toBe(true);
    expect(jobs.filter((j) => j.data.projectId === 'p1')).toHaveLength(2);
  });
});
