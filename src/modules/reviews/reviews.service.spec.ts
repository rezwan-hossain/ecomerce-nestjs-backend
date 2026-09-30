import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { ReviewsService } from './reviews.service';
import { PrismaService } from 'src/prisma/prisma.service';

function createMockPrisma() {
  return {
    review: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      aggregate: jest.fn(),
      groupBy: jest.fn(),
    },
    product: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    orderItem: { findFirst: jest.fn() },
  };
}

type MockPrisma = ReturnType<typeof createMockPrisma>;

function firstCallArg<T>(mockFn: jest.Mock): T {
  const args = mockFn.mock.calls[0] as unknown[];
  return args[0] as T;
}

const USER = 'user-1';
const PRODUCT = 'product-1';

describe('ReviewsService', () => {
  let service: ReviewsService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [ReviewsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<ReviewsService>(ReviewsService);
  });

  describe('create', () => {
    const dto = { productId: PRODUCT, rating: 5, title: 'Great' };

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ id: USER });
      prisma.product.findFirst.mockResolvedValue({ id: PRODUCT });
      prisma.review.create.mockResolvedValue({ id: 'r1' });
    });

    it('marks the review verified when the user has a delivered order', async () => {
      prisma.orderItem.findFirst.mockResolvedValue({ id: 'oi1' });

      await service.create(USER, dto);

      const arg = firstCallArg<{ data: { isVerifiedPurchase: boolean } }>(
        prisma.review.create,
      );
      expect(arg.data.isVerifiedPurchase).toBe(true);
      const purchaseQuery = firstCallArg<{ where: unknown }>(
        prisma.orderItem.findFirst,
      );
      expect(purchaseQuery.where).toEqual({
        productId: PRODUCT,
        order: { userId: USER, status: { in: ['DELIVERED', 'COMPLETED'] } },
      });
    });

    it('allows unverified reviews', async () => {
      prisma.orderItem.findFirst.mockResolvedValue(null);

      await service.create(USER, dto);

      const arg = firstCallArg<{ data: { isVerifiedPurchase: boolean } }>(
        prisma.review.create,
      );
      expect(arg.data.isVerifiedPurchase).toBe(false);
    });

    it('rejects a soft-deleted or missing product', async () => {
      prisma.product.findFirst.mockResolvedValue(null);

      await expect(service.create(USER, dto)).rejects.toThrow(
        NotFoundException,
      );
      const arg = firstCallArg<{ where: unknown }>(prisma.product.findFirst);
      expect(arg.where).toEqual({ id: PRODUCT, deletedAt: null });
    });

    it('maps a second review of the same product to ConflictException', async () => {
      prisma.orderItem.findFirst.mockResolvedValue(null);
      prisma.review.create.mockRejectedValue(
        new PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(service.create(USER, dto)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('findForProduct', () => {
    it('lists approved reviews with a full 1–5 rating distribution', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: PRODUCT });
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(3);
      prisma.review.aggregate.mockResolvedValue({
        _avg: { rating: 4.3333 },
        _count: { _all: 3 },
      });
      prisma.review.groupBy.mockResolvedValue([
        { rating: 5, _count: { _all: 2 } },
        { rating: 3, _count: { _all: 1 } },
      ]);

      const result = await service.findForProduct(PRODUCT, {
        page: 1,
        limit: 10,
        sort: 'highest',
      });

      const arg = firstCallArg<{ where: unknown; orderBy: unknown }>(
        prisma.review.findMany,
      );
      expect(arg.where).toEqual({ productId: PRODUCT, status: 'APPROVED' });
      expect(arg.orderBy).toEqual([{ rating: 'desc' }, { createdAt: 'desc' }]);
      expect(result.summary).toEqual({
        averageRating: 4.3,
        totalReviews: 3,
        distribution: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 2 },
      });
    });

    it('filters the page by rating but keeps the summary over all approved', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: PRODUCT });
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(0);
      prisma.review.aggregate.mockResolvedValue({
        _avg: { rating: null },
        _count: { _all: 0 },
      });
      prisma.review.groupBy.mockResolvedValue([]);

      const result = await service.findForProduct(PRODUCT, {
        page: 1,
        limit: 10,
        rating: 1,
        sort: 'newest',
      });

      const listArg = firstCallArg<{ where: unknown }>(prisma.review.findMany);
      expect(listArg.where).toEqual({
        productId: PRODUCT,
        status: 'APPROVED',
        rating: 1,
      });
      const summaryArg = firstCallArg<{ where: unknown }>(
        prisma.review.aggregate,
      );
      expect(summaryArg.where).toEqual({
        productId: PRODUCT,
        status: 'APPROVED',
      });
      expect(result.summary.averageRating).toBeNull();
    });
  });

  describe('update', () => {
    it('sends an edited review back to PENDING', async () => {
      prisma.review.findUnique.mockResolvedValue({ userId: USER });
      prisma.review.update.mockResolvedValue({ id: 'r1' });

      await service.update('r1', USER, { rating: 2, body: null });

      const arg = firstCallArg<{ data: unknown }>(prisma.review.update);
      expect(arg.data).toEqual({ rating: 2, body: null, status: 'PENDING' });
    });

    it("rejects editing someone else's review", async () => {
      prisma.review.findUnique.mockResolvedValue({ userId: 'other' });

      await expect(service.update('r1', USER, { rating: 1 })).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.review.update).not.toHaveBeenCalled();
    });
  });

  describe('moderate', () => {
    it('sets the status', async () => {
      prisma.review.findUnique.mockResolvedValue({ id: 'r1' });
      prisma.review.update.mockResolvedValue({ id: 'r1' });

      const result = await service.moderate('r1', { status: 'APPROVED' });

      expect(prisma.review.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { status: 'APPROVED' },
      });
      expect(result.message).toBe('Review approved');
    });
  });

  describe('remove', () => {
    it('throws NotFoundException for a missing review', async () => {
      prisma.review.findUnique.mockResolvedValue(null);

      await expect(service.remove('nope', USER)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("rejects deleting someone else's review", async () => {
      prisma.review.findUnique.mockResolvedValue({ userId: 'other' });

      await expect(service.remove('r1', USER)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.review.delete).not.toHaveBeenCalled();
    });
  });
});
