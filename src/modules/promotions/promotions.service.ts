import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { PromotionWhereInput } from 'src/generated/prisma/models/Promotion'; // adjust path if needed

import {
  CreatePromotionDto,
  UpdatePromotionDto,
  PromotionQueryDto,
} from './dto/promotion.dto';
import { AttachTargetsDto } from './dto/promotion-target.dto';
import { AttachCampaignsDto } from './dto/promotion-campaign.dto';

type TargetInput = AttachTargetsDto['targets'][number];

@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  // ═════════════════════════════════════════════════
  //   CREATE
  // ═════════════════════════════════════════════════

  async create(dto: CreatePromotionDto) {
    try {
      const promotion = await this.prisma.promotion.create({
        data: {
          name: dto.name,
          description: dto.description,
          type: dto.type,
          status: dto.status,
          value: dto.value,
          buyQuantity: dto.buyQuantity,
          getQuantity: dto.getQuantity,
          minOrderAmount: dto.minOrderAmount,
          maxDiscountAmount: dto.maxDiscountAmount,
          startsAt: dto.startsAt,
          endsAt: dto.endsAt,
          isActive: dto.isActive,
          priority: dto.priority,
        },
      });

      return { message: 'Promotion created successfully', data: promotion };
    } catch (error) {
      this.handlePrismaError(error, 'Promotion');
    }
  }

  // ═════════════════════════════════════════════════
  //   LIST
  // ═════════════════════════════════════════════════

  async findAll(query: PromotionQueryDto) {
    const { page = 1, limit = 20, search, type, status, isActive } = query;
    const skip = (page - 1) * limit;

    const where: PromotionWhereInput = {};

    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }
    if (type) where.type = type;
    if (status) where.status = status;
    if (isActive !== undefined) where.isActive = isActive;

    const [items, total] = await Promise.all([
      this.prisma.promotion.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        include: {
          _count: { select: { campaigns: true, targets: true } },
        },
      }),
      this.prisma.promotion.count({ where }),
    ]);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  // ═════════════════════════════════════════════════
  //   FIND ONE
  // ═════════════════════════════════════════════════

  async findOne(id: string) {
    const promotion = await this.prisma.promotion.findUnique({
      where: { id },
      include: {
        campaigns: {
          include: {
            campaign: {
              select: {
                id: true,
                name: true,
                slug: true,
                status: true,
                isActive: true,
              },
            },
          },
        },
        targets: {
          include: {
            product: { select: { id: true, name: true, slug: true } },
            variant: { select: { id: true, sku: true, price: true } },
            category: { select: { id: true, name: true, slug: true } },
            brand: { select: { id: true, name: true, slug: true } },
            tag: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });

    if (!promotion) {
      throw new NotFoundException(`Promotion "${id}" not found`);
    }

    return { data: promotion };
  }

  // ═════════════════════════════════════════════════
  //   UPDATE
  // ═════════════════════════════════════════════════

  async update(id: string, dto: UpdatePromotionDto) {
    await this.ensurePromotionExistsAndActive(id);

    try {
      const promotion = await this.prisma.promotion.update({
        where: { id },
        data: { ...dto },
      });
      return { message: 'Promotion updated', data: promotion };
    } catch (error) {
      this.handlePrismaError(error, 'Promotion');
    }
  }

  // ═════════════════════════════════════════════════
  //   ARCHIVE
  // ═════════════════════════════════════════════════

  async archive(id: string) {
    await this.ensurePromotionExists(id);

    const promotion = await this.prisma.promotion.update({
      where: { id },
      data: {
        status: 'ARCHIVED',
        isActive: false,
      },
    });

    return { message: 'Promotion archived', data: promotion };
  }

  // ═════════════════════════════════════════════════
  //   DELETE
  // ═════════════════════════════════════════════════

  async remove(id: string) {
    await this.ensurePromotionExists(id);
    await this.prisma.promotion.delete({ where: { id } });
    return { message: 'Promotion deleted successfully' };
  }

  // ═════════════════════════════════════════════════
  //   TARGETS
  // ═════════════════════════════════════════════════

  async attachTargets(promotionId: string, dto: AttachTargetsDto) {
    await this.ensurePromotionExistsAndActive(promotionId);
    await this.validateTargetReferences(dto.targets);

    const data = dto.targets.map((t) => this.mapTargetToRow(promotionId, t));

    await this.prisma.promotionTarget.createMany({
      data,
      skipDuplicates: true,
    });

    return { message: 'Targets attached to promotion' };
  }

  async listTargets(promotionId: string) {
    await this.ensurePromotionExists(promotionId);

    const targets = await this.prisma.promotionTarget.findMany({
      where: { promotionId },
      include: {
        product: {
          include: {
            images: { where: { isPrimary: true }, take: 1 },
          },
        },
        variant: true,
        category: true,
        brand: true,
        tag: true,
      },
    });

    return { data: targets };
  }

  async detachTarget(targetId: string) {
    const target = await this.prisma.promotionTarget.findUnique({
      where: { id: targetId },
      select: { id: true, promotionId: true },
    });

    if (!target) {
      throw new NotFoundException(`Target "${targetId}" not found`);
    }

    await this.ensurePromotionExistsAndActive(target.promotionId);

    try {
      await this.prisma.promotionTarget.delete({ where: { id: targetId } });
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Target already removed');
      }
      throw error;
    }

    return { message: 'Target detached' };
  }

  // ═════════════════════════════════════════════════
  //   CAMPAIGNS
  // ═════════════════════════════════════════════════

  async attachCampaigns(promotionId: string, dto: AttachCampaignsDto) {
    await this.ensurePromotionExistsAndActive(promotionId);

    // Validate campaigns exist
    const campaigns = await this.prisma.campaign.findMany({
      where: { id: { in: dto.campaignIds } },
      select: { id: true },
    });

    if (campaigns.length !== dto.campaignIds.length) {
      throw new BadRequestException('One or more campaigns do not exist');
    }

    await this.prisma.promotionCampaign.createMany({
      data: dto.campaignIds.map((campaignId) => ({
        promotionId,
        campaignId,
      })),
      skipDuplicates: true,
    });

    return { message: 'Campaigns attached' };
  }

  async listCampaigns(promotionId: string) {
    await this.ensurePromotionExists(promotionId);

    const items = await this.prisma.promotionCampaign.findMany({
      where: { promotionId },
      include: {
        campaign: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            isActive: true,
            startsAt: true,
            endsAt: true,
            thumbnailUrl: true,
          },
        },
      },
    });

    return { data: items };
  }

  async detachCampaign(promotionId: string, campaignId: string) {
    await this.ensurePromotionExistsAndActive(promotionId);

    try {
      await this.prisma.promotionCampaign.delete({
        where: { promotionId_campaignId: { promotionId, campaignId } },
      });
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Campaign is not linked to this promotion');
      }
      throw error;
    }

    return { message: 'Campaign detached' };
  }

  // ═════════════════════════════════════════════════
  //   HELPERS
  // ═════════════════════════════════════════════════

  private async ensurePromotionExists(id: string) {
    const promotion = await this.prisma.promotion.findUnique({
      where: { id },
      select: { id: true, status: true, isActive: true },
    });

    if (!promotion) {
      throw new NotFoundException(`Promotion "${id}" not found`);
    }

    return promotion;
  }

  private async ensurePromotionExistsAndActive(id: string) {
    const promotion = await this.ensurePromotionExists(id);

    if (promotion.status === 'ARCHIVED' || !promotion.isActive) {
      throw new ForbiddenException(
        'Cannot modify an archived or inactive promotion',
      );
    }

    return promotion;
  }

  private mapTargetToRow(promotionId: string, t: TargetInput) {
    return {
      promotionId,
      targetType: t.targetType,
      productId: t.targetType === 'PRODUCT' ? (t.productId ?? null) : null,
      variantId: t.targetType === 'VARIANT' ? (t.variantId ?? null) : null,
      categoryId: t.targetType === 'CATEGORY' ? (t.categoryId ?? null) : null,
      brandId: t.targetType === 'BRAND' ? (t.brandId ?? null) : null,
      tagId: t.targetType === 'TAG' ? (t.tagId ?? null) : null,
    };
  }

  /**
   * Validates all referenced foreign entities exist in the DB.
   * Prevents orphan targets from being created.
   */
  private async validateTargetReferences(targets: TargetInput[]) {
    const productIds = targets
      .filter((t) => t.targetType === 'PRODUCT' && t.productId)
      .map((t) => t.productId!);
    const variantIds = targets
      .filter((t) => t.targetType === 'VARIANT' && t.variantId)
      .map((t) => t.variantId!);
    const categoryIds = targets
      .filter((t) => t.targetType === 'CATEGORY' && t.categoryId)
      .map((t) => t.categoryId!);
    const brandIds = targets
      .filter((t) => t.targetType === 'BRAND' && t.brandId)
      .map((t) => t.brandId!);
    const tagIds = targets
      .filter((t) => t.targetType === 'TAG' && t.tagId)
      .map((t) => t.tagId!);

    const [products, variants, categories, brands, tags] = await Promise.all([
      productIds.length
        ? this.prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true },
          })
        : Promise.resolve([]),
      variantIds.length
        ? this.prisma.productVariant.findMany({
            where: { id: { in: variantIds } },
            select: { id: true },
          })
        : Promise.resolve([]),
      categoryIds.length
        ? this.prisma.category.findMany({
            where: { id: { in: categoryIds } },
            select: { id: true },
          })
        : Promise.resolve([]),
      brandIds.length
        ? this.prisma.brand.findMany({
            where: { id: { in: brandIds } },
            select: { id: true },
          })
        : Promise.resolve([]),
      tagIds.length
        ? this.prisma.tag.findMany({
            where: { id: { in: tagIds } },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);

    if (products.length !== productIds.length)
      throw new BadRequestException('One or more products do not exist');
    if (variants.length !== variantIds.length)
      throw new BadRequestException('One or more variants do not exist');
    if (categories.length !== categoryIds.length)
      throw new BadRequestException('One or more categories do not exist');
    if (brands.length !== brandIds.length)
      throw new BadRequestException('One or more brands do not exist');
    if (tags.length !== tagIds.length)
      throw new BadRequestException('One or more tags do not exist');
  }

  private handlePrismaError(error: unknown, entity: string): never {
    if (error instanceof PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        const target = error.meta?.target;
        const field = Array.isArray(target)
          ? target.join(', ')
          : typeof target === 'string'
            ? target
            : 'field';

        throw new ConflictException(
          `${entity} with this ${field} already exists`,
        );
      }

      if (error.code === 'P2025') {
        throw new NotFoundException(`${entity} not found`);
      }
    }

    if (
      error instanceof NotFoundException ||
      error instanceof ConflictException ||
      error instanceof BadRequestException ||
      error instanceof ForbiddenException
    ) {
      throw error;
    }

    throw error;
  }
}
