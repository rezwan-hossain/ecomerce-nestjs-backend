import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CreateReviewDto,
  UpdateReviewDto,
  ModerateReviewDto,
  ReviewQueryDto,
  ProductReviewQueryDto,
} from './dto/review.dto';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import {
  ReviewOrderByWithRelationInput,
  ReviewWhereInput,
} from 'src/generated/prisma/models/Review';

// Public-safe reviewer fields — never expose email/phone on reviews.
const REVIEWER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  image: true,
} as const;

const PRODUCT_SORT: Record<
  ProductReviewQueryDto['sort'],
  ReviewOrderByWithRelationInput[]
> = {
  newest: [{ createdAt: 'desc' }],
  highest: [{ rating: 'desc' }, { createdAt: 'desc' }],
  lowest: [{ rating: 'asc' }, { createdAt: 'desc' }],
};

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────
  // CREATE REVIEW (Customer)
  // New reviews start PENDING and are hidden until approved.
  // ──────────────────────────────────────────────
  async create(userId: string, dto: CreateReviewDto) {
    await this.ensureUserExists(userId);
    await this.ensureProductExists(dto.productId);

    const purchase = await this.prisma.orderItem.findFirst({
      where: {
        productId: dto.productId,
        order: { userId, status: { in: ['DELIVERED', 'COMPLETED'] } },
      },
      select: { id: true },
    });

    try {
      const review = await this.prisma.review.create({
        data: {
          productId: dto.productId,
          userId,
          rating: dto.rating,
          title: dto.title,
          body: dto.body,
          isVerifiedPurchase: !!purchase,
        },
      });

      return {
        message: 'Review submitted and awaiting moderation',
        data: review,
      };
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('You have already reviewed this product');
      }
      throw error;
    }
  }

  // ──────────────────────────────────────────────
  // LIST PRODUCT REVIEWS + RATING SUMMARY (Public)
  // ──────────────────────────────────────────────
  async findForProduct(productId: string, query: ProductReviewQueryDto) {
    await this.ensureProductExists(productId);

    const { page, limit, rating, sort } = query;
    const skip = (page - 1) * limit;

    const approved: ReviewWhereInput = { productId, status: 'APPROVED' };
    const where: ReviewWhereInput = rating ? { ...approved, rating } : approved;

    const [reviews, total, summary] = await Promise.all([
      this.prisma.review.findMany({
        where,
        skip,
        take: limit,
        orderBy: PRODUCT_SORT[sort],
        include: { user: { select: REVIEWER_SELECT } },
      }),
      this.prisma.review.count({ where }),
      this.getRatingSummary(approved),
    ]);

    return {
      data: reviews,
      summary,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ──────────────────────────────────────────────
  // LIST ALL REVIEWS (ADMIN+) — moderation queue etc.
  // ──────────────────────────────────────────────
  async findAll(query: ReviewQueryDto) {
    const { page, limit, productId, userId, status, rating } = query;
    const skip = (page - 1) * limit;

    const where: ReviewWhereInput = {
      ...(productId && { productId }),
      ...(userId && { userId }),
      ...(status && { status }),
      ...(rating && { rating }),
    };

    const [reviews, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { ...REVIEWER_SELECT, email: true } },
          product: { select: { id: true, name: true, slug: true } },
        },
      }),
      this.prisma.review.count({ where }),
    ]);

    return {
      data: reviews,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ──────────────────────────────────────────────
  // GET REVIEW BY ID
  // ──────────────────────────────────────────────
  async findOne(id: string) {
    const review = await this.prisma.review.findUnique({
      where: { id },
      include: {
        user: { select: REVIEWER_SELECT },
        product: { select: { id: true, name: true, slug: true } },
      },
    });

    if (!review) {
      throw new NotFoundException(`Review with ID "${id}" not found`);
    }

    return { data: review };
  }

  // ──────────────────────────────────────────────
  // UPDATE REVIEW (Author)
  // Any edit sends the review back to PENDING for re-moderation.
  // ──────────────────────────────────────────────
  async update(id: string, userId: string, dto: UpdateReviewDto) {
    await this.ensureOwnedBy(id, userId);

    const review = await this.prisma.review.update({
      where: { id },
      data: {
        ...(dto.rating !== undefined && { rating: dto.rating }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.body !== undefined && { body: dto.body }),
        status: 'PENDING',
      },
    });

    return {
      message: 'Review updated and awaiting moderation',
      data: review,
    };
  }

  // ──────────────────────────────────────────────
  // MODERATE REVIEW (ADMIN+)
  // ──────────────────────────────────────────────
  async moderate(id: string, dto: ModerateReviewDto) {
    await this.ensureExists(id);

    const review = await this.prisma.review.update({
      where: { id },
      data: { status: dto.status },
    });

    return {
      message: `Review ${dto.status.toLowerCase()}`,
      data: review,
    };
  }

  // ──────────────────────────────────────────────
  // DELETE REVIEW (Author)
  // Admins hide reviews by rejecting them instead.
  // ──────────────────────────────────────────────
  async remove(id: string, userId: string) {
    await this.ensureOwnedBy(id, userId);

    await this.prisma.review.delete({
      where: { id },
    });

    return { message: 'Review deleted successfully' };
  }

  // ──────────────────────────────────────────────
  // HELPER METHODS
  // ──────────────────────────────────────────────
  private async getRatingSummary(where: ReviewWhereInput) {
    const [aggregate, groups] = await Promise.all([
      this.prisma.review.aggregate({
        where,
        _avg: { rating: true },
        _count: { _all: true },
      }),
      this.prisma.review.groupBy({
        by: ['rating'],
        where,
        _count: { _all: true },
      }),
    ]);

    // Always return all five buckets so clients can render a full histogram.
    const distribution: Record<number, number> = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };
    for (const g of groups) distribution[g.rating] = g._count._all;

    const avg = aggregate._avg.rating;
    return {
      averageRating: avg === null ? null : Math.round(avg * 10) / 10,
      totalReviews: aggregate._count._all,
      distribution,
    };
  }

  private async ensureExists(id: string) {
    const exists = await this.prisma.review.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!exists) {
      throw new NotFoundException(`Review with ID "${id}" not found`);
    }
  }

  private async ensureOwnedBy(id: string, userId: string) {
    const review = await this.prisma.review.findUnique({
      where: { id },
      select: { userId: true },
    });

    if (!review) {
      throw new NotFoundException(`Review with ID "${id}" not found`);
    }
    if (review.userId !== userId) {
      throw new ForbiddenException('You can only modify your own reviews');
    }
  }

  private async ensureProductExists(productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });

    if (!product) {
      throw new NotFoundException(`Product with ID "${productId}" not found`);
    }
  }

  private async ensureUserExists(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found`);
    }
  }
}
