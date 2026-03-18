import { HealthScoreService } from './health-score.service';

describe('HealthScoreService', () => {
  let service: HealthScoreService;

  const mockDb = {
    query: {
      collections: {
        findMany: jest.fn(),
      },
    },
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  };

  beforeEach(() => {
    service = new HealthScoreService(mockDb as any);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should compute a score between 0 and 100', async () => {
    // Mock collections with healthy metrics
    mockDb.query.collections.findMany.mockResolvedValue([
      { holderCount: 500, listedCount: 50, supply: 1000 },
    ]);

    // Mock activity and event counts
    mockDb.from.mockReturnThis();
    mockDb.where.mockResolvedValue([{ count: 25 }]);
    mockDb.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) });

    const score = await service.computeHealthScore('test-project-id');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});
