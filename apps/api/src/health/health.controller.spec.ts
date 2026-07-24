import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = { $queryRaw: jest.fn() };

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    jest.clearAllMocks();
  });

  it('should return ok for /healthz', () => {
    expect(controller.healthz()).toEqual({ status: 'ok' });
  });

  it('should return ok for /readyz when DB is reachable', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ '1': 1 }]);
    await expect(controller.readyz()).resolves.toEqual({ status: 'ok' });
  });

  it('should throw ServiceUnavailableException when DB is unreachable', async () => {
    mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('Connection refused'));
    await expect(controller.readyz()).rejects.toThrow(ServiceUnavailableException);
  });
});
