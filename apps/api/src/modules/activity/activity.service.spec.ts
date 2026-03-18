import { ForbiddenException } from '@nestjs/common';
import { ActivityService } from './activity.service';
import { HolderVerificationService } from './holder-verification.service';

describe('ActivityService', () => {
  let service: ActivityService;
  let holderVerification: jest.Mocked<HolderVerificationService>;

  const mockDb = {
    query: {
      activityFeed: {
        findMany: jest.fn(),
      },
      collections: {
        findFirst: jest.fn(),
      },
    },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn(),
      }),
    }),
  };

  beforeEach(() => {
    holderVerification = {
      verifyEthereumHolder: jest.fn(),
      verifySolanaHolder: jest.fn(),
    } as any;

    service = new ActivityService(mockDb as any, holderVerification);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createFlex', () => {
    it('should throw ForbiddenException when wallet does not hold NFT', async () => {
      mockDb.query.collections.findFirst.mockResolvedValue({
        id: 'col-1',
        chain: 'ethereum',
        contractAddress: '0xabc',
      });
      holderVerification.verifyEthereumHolder.mockResolvedValue(false);

      await expect(
        service.createFlex('proj-1', {
          walletAddress: '0x123',
          collectionId: 'col-1',
          tokenId: '42',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should create flex when wallet holds NFT', async () => {
      mockDb.query.collections.findFirst.mockResolvedValue({
        id: 'col-1',
        chain: 'ethereum',
        contractAddress: '0xabc',
      });
      holderVerification.verifyEthereumHolder.mockResolvedValue(true);

      const mockFlex = { id: 'flex-1', activityType: 'flex' };
      mockDb.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([mockFlex]),
        }),
      });

      const result = await service.createFlex('proj-1', {
        walletAddress: '0x123',
        collectionId: 'col-1',
        tokenId: '42',
      });
      expect(result).toEqual(mockFlex);
    });
  });
});
