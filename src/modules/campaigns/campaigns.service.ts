import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { CampaignWhereInput } from 'src/generated/prisma/models/Campaign'; // adjust path if needed
import { ProductWhereInput } from 'src/generated/prisma/models/Product';


import {
  CreateCampaignDto,
  UpdateCampaignDto,
  CampaignQueryDto,
} from './dto/campaign.dto';
import {
  CreateCampaignBannerDto,
  UpdateCampaignBannerDto,
  ReorderBannersDto,
} from './dto/campaign-banner.dto';
import {
  CreateCampaignSectionDto,
  UpdateCampaignSectionDto,
  AttachSectionProductsDto,
  ReorderSectionsDto,
} from './dto/campaign-section.dto';
import {
  CreateSectionRuleDto,
  UpdateSectionRuleDto,
} from './dto/campaign-section-rule.dto';

@Injectable()
export class CampaignsService {
  constructor(private readonly prisma: PrismaService) {}

  // ═════════════════════════════════════════════════
  //   CAMPAIGN CRUD
  // ═════════════════════════════════════════════════

  async create(dto: CreateCampaignDto) {
    try {
      const campaign = await this.prisma.campaign.create({
        data: { ...dto },
      });
      return { message: 'Campaign created successfully', data: campaign };
    } catch (error) {
      this.handlePrismaError(error, 'Campaign');
    }
  }

  async findAll(query: CampaignQueryDto) {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      isActive,
      isFeatured,
    } = query;
    const skip = (page - 1) * limit;

    const where: CampaignWhereInput = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (status) where.status = status;
    if (isActive !== undefined) where.isActive = isActive;
    if (isFeatured !== undefined) where.isFeatured = isFeatured;

    const [items, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ isFeatured: 'desc' }, { createdAt: 'desc' }],
        include: {
          _count: {
            select: { banners: true, sections: true, promotions: true },
          },
        },
      }),
      this.prisma.campaign.count({ where }),
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

  async findOne(id: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      include: {
        banners: { orderBy: { position: 'asc' } },
        sections: {
          orderBy: { position: 'asc' },
          include: {
            _count: { select: { products: true, campaignRules: true } },
          },
        },
        _count: { select: { promotions: true } },
      },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign "${id}" not found`);
    }

    return { data: campaign };
  }

  async findBySlug(slug: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { slug },
      include: {
        banners: {
          where: { isActive: true },
          orderBy: { position: 'asc' },
        },
        sections: {
          where: { isActive: true },
          orderBy: { position: 'asc' },
          include: {
            products: {
              orderBy: { position: 'asc' },
              include: {
                product: {
                  include: {
                    images: { where: { isPrimary: true }, take: 1 },
                    variants: { where: { isActive: true }, take: 1 },
                    brand: true,
                  },
                },
              },
            },
            campaignRules: {
              include: {
                category: true,
                brand: true,
                tag: true,
              },
            },
          },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign slug "${slug}" not found`);
    }

    return { data: campaign };
  }

  async update(id: string, dto: UpdateCampaignDto) {
    await this.ensureCampaignExistsAndActive(id);

    try {
      const campaign = await this.prisma.campaign.update({
        where: { id },
        data: { ...dto },
      });
      return { message: 'Campaign updated', data: campaign };
    } catch (error) {
      this.handlePrismaError(error, 'Campaign');
    }
  }

  async archive(id: string) {
    await this.ensureCampaignExists(id);

    const campaign = await this.prisma.campaign.update({
      where: { id },
      data: {
        status: 'ARCHIVED',
        isActive: false,
        archivedAt: new Date(),
      },
    });

    return { message: 'Campaign archived', data: campaign };
  }

  async remove(id: string) {
    await this.ensureCampaignExists(id);

    // Optional: prevent hard delete if campaign has orders/promotions history
    // You can add business logic here later

    await this.prisma.campaign.delete({ where: { id } });
    return { message: 'Campaign deleted successfully' };
  }

  // ═════════════════════════════════════════════════
  //   BANNERS
  // ═════════════════════════════════════════════════

  async createBanner(campaignId: string, dto: CreateCampaignBannerDto) {
    await this.ensureCampaignExistsAndActive(campaignId);

    const banner = await this.prisma.campaignBanner.create({
      data: { ...dto, campaignId },
    });

    return { message: 'Banner created', data: banner };
  }

  async listBanners(campaignId: string) {
    await this.ensureCampaignExists(campaignId);

    const banners = await this.prisma.campaignBanner.findMany({
      where: { campaignId },
      orderBy: { position: 'asc' },
    });

    return { data: banners };
  }

  async updateBanner(bannerId: string, dto: UpdateCampaignBannerDto) {
    const banner = await this.ensureBannerExists(bannerId);
    await this.ensureCampaignExistsAndActive(banner.campaignId);

    const updated = await this.prisma.campaignBanner.update({
      where: { id: bannerId },
      data: { ...dto },
    });

    return { message: 'Banner updated', data: updated };
  }

  async removeBanner(bannerId: string) {
    const banner = await this.ensureBannerExists(bannerId);
    await this.ensureCampaignExistsAndActive(banner.campaignId);

    await this.prisma.campaignBanner.delete({ where: { id: bannerId } });
    return { message: 'Banner removed' };
  }

  async reorderBanners(campaignId: string, dto: ReorderBannersDto) {
    await this.ensureCampaignExistsAndActive(campaignId);

    // Security: ensure all banner IDs belong to this campaign
    const bannerIds = dto.items.map((item) => item.id);
    const existing = await this.prisma.campaignBanner.findMany({
      where: { id: { in: bannerIds }, campaignId },
      select: { id: true },
    });

    if (existing.length !== bannerIds.length) {
      throw new BadRequestException(
        'One or more banners do not belong to this campaign',
      );
    }

    await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.campaignBanner.update({
          where: { id: item.id },
          data: { position: item.position },
        }),
      ),
    );

    return { message: 'Banners reordered' };
  }

  // ═════════════════════════════════════════════════
  //   SECTIONS
  // ═════════════════════════════════════════════════

  async createSection(campaignId: string, dto: CreateCampaignSectionDto) {
    await this.ensureCampaignExistsAndActive(campaignId);

    try {
      const section = await this.prisma.campaignSection.create({
        data: { ...dto, campaignId },
      });
      return { message: 'Section created', data: section };
    } catch (error) {
      this.handlePrismaError(error, 'Section');
    }
  }

  async listSections(campaignId: string) {
    await this.ensureCampaignExists(campaignId);

    const sections = await this.prisma.campaignSection.findMany({
      where: { campaignId },
      orderBy: { position: 'asc' },
      include: {
        _count: { select: { products: true, campaignRules: true } },
      },
    });

    return { data: sections };
  }

  async updateSection(sectionId: string, dto: UpdateCampaignSectionDto) {
    const section = await this.ensureSectionExists(sectionId);
    await this.ensureCampaignExistsAndActive(section.campaignId);

    try {
      const updated = await this.prisma.campaignSection.update({
        where: { id: sectionId },
        data: { ...dto },
      });
      return { message: 'Section updated', data: updated };
    } catch (error) {
      this.handlePrismaError(error, 'Section');
    }
  }

  async removeSection(sectionId: string) {
    const section = await this.ensureSectionExists(sectionId);
    await this.ensureCampaignExistsAndActive(section.campaignId);

    await this.prisma.campaignSection.delete({ where: { id: sectionId } });
    return { message: 'Section removed' };
  }

  async reorderSections(campaignId: string, dto: ReorderSectionsDto) {
    await this.ensureCampaignExistsAndActive(campaignId);

    const sectionIds = dto.items.map((item) => item.id);
    const existing = await this.prisma.campaignSection.findMany({
      where: { id: { in: sectionIds }, campaignId },
      select: { id: true },
    });

    if (existing.length !== sectionIds.length) {
      throw new BadRequestException(
        'One or more sections do not belong to this campaign',
      );
    }

    await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.campaignSection.update({
          where: { id: item.id },
          data: { position: item.position },
        }),
      ),
    );

    return { message: 'Sections reordered' };
  }

  // ═════════════════════════════════════════════════
  //   ATTACH PRODUCTS TO SECTION
  // ═════════════════════════════════════════════════

  async attachProductsToSection(
    sectionId: string,
    dto: AttachSectionProductsDto,
  ) {
    const section = await this.ensureSectionExists(sectionId);
    await this.ensureCampaignExistsAndActive(section.campaignId);

    const productIds = dto.products.map((p) => p.productId);

    // Validate all products exist and are active
    const existingProducts = await this.prisma.product.findMany({
      where: {
        id: { in: productIds },
        isActive: true,
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    if (existingProducts.length !== productIds.length) {
      throw new BadRequestException(
        'One or more products do not exist or are not active',
      );
    }

    const results = await this.prisma.$transaction(
      dto.products.map((p) =>
        this.prisma.campaignSectionProduct.upsert({
          where: {
            sectionId_productId: {
              sectionId,
              productId: p.productId,
            },
          },
          update: { position: p.position },
          create: {
            sectionId,
            productId: p.productId,
            position: p.position,
          },
        }),
      ),
    );

    return { message: 'Products attached', data: results };
  }

  async listSectionProducts(sectionId: string) {
    await this.ensureSectionExists(sectionId);

    const items = await this.prisma.campaignSectionProduct.findMany({
      where: { sectionId },
      orderBy: { position: 'asc' },
      include: {
        product: {
          include: {
            images: { where: { isPrimary: true }, take: 1 },
            brand: true,
            variants: { where: { isActive: true }, take: 1 },
          },
        },
      },
    });

    return { data: items };
  }

  async detachProductFromSection(sectionId: string, productId: string) {
    const section = await this.ensureSectionExists(sectionId);
    await this.ensureCampaignExistsAndActive(section.campaignId);

    try {
      await this.prisma.campaignSectionProduct.delete({
        where: {
          sectionId_productId: { sectionId, productId },
        },
      });
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Product is not attached to this section');
      }
      throw error;
    }

    return { message: 'Product detached' };
  }

  // ═════════════════════════════════════════════════
  //   SECTION RULES (dynamic filters)
  // ═════════════════════════════════════════════════

  async createSectionRule(sectionId: string, dto: CreateSectionRuleDto) {
    const section = await this.ensureSectionExists(sectionId);
    await this.ensureCampaignExistsAndActive(section.campaignId);

    // Basic validation: at least one filter should be present
    if (
      !dto.categoryId &&
      !dto.brandId &&
      !dto.tagId &&
      dto.minPrice == null &&
      dto.maxPrice == null
    ) {
      throw new BadRequestException(
        'At least one filter (category, brand, tag, or price range) is required',
      );
    }

    const rule = await this.prisma.campaignSectionRule.create({
      data: {
        sectionId,
        categoryId: dto.categoryId,
        brandId: dto.brandId,
        tagId: dto.tagId,
        matchType: dto.matchType ?? 'ALL',
        minPrice: dto.minPrice,
        maxPrice: dto.maxPrice,
      },
    });

    return { message: 'Rule created', data: rule };
  }

  async listSectionRules(sectionId: string) {
    await this.ensureSectionExists(sectionId);

    const rules = await this.prisma.campaignSectionRule.findMany({
      where: { sectionId },
      include: {
        category: true,
        brand: true,
        tag: true,
      },
    });

    return { data: rules };
  }

  async updateSectionRule(ruleId: string, dto: UpdateSectionRuleDto) {
    const rule = await this.prisma.campaignSectionRule.findUnique({
      where: { id: ruleId },
      include: { section: true },
    });

    if (!rule) {
      throw new NotFoundException(`Rule "${ruleId}" not found`);
    }

    await this.ensureCampaignExistsAndActive(rule.section.campaignId);

    const updated = await this.prisma.campaignSectionRule.update({
      where: { id: ruleId },
      data: { ...dto },
    });

    return { message: 'Rule updated', data: updated };
  }

  async removeSectionRule(ruleId: string) {
    const rule = await this.prisma.campaignSectionRule.findUnique({
      where: { id: ruleId },
      include: { section: true },
    });

    if (!rule) {
      throw new NotFoundException(`Rule "${ruleId}" not found`);
    }

    await this.ensureCampaignExistsAndActive(rule.section.campaignId);

    await this.prisma.campaignSectionRule.delete({ where: { id: ruleId } });
    return { message: 'Rule removed' };
  }

  // ═════════════════════════════════════════════════
  //   RULE PREVIEW (runtime matched products)
  // ═════════════════════════════════════════════════

  async previewRuleMatches(sectionId: string) {
    await this.ensureSectionExists(sectionId);

    const rules = await this.prisma.campaignSectionRule.findMany({
      where: { sectionId },
    });

    if (rules.length === 0) {
      return { data: [], count: 0 };
    }

    // Build conditions for each rule
    const ruleConditions: ProductWhereInput[] = rules.map((rule) => {
      const filters: ProductWhereInput[] = [];

      if (rule.categoryId) {
        filters.push({
          categories: { some: { categoryId: rule.categoryId } },
        });
      }
      if (rule.brandId) {
        filters.push({ brandId: rule.brandId });
      }
      if (rule.tagId) {
        filters.push({ tags: { some: { tagId: rule.tagId } } });
      }
      if (rule.minPrice !== null || rule.maxPrice !== null) {
        filters.push({
          variants: {
            some: {
              isActive: true,
              price: {
                ...(rule.minPrice !== null && { gte: rule.minPrice }),
                ...(rule.maxPrice !== null && { lte: rule.maxPrice }),
              },
            },
          },
        });
      }

      const base: ProductWhereInput = {
        isActive: true,
        status: 'ACTIVE',
      };

      if (filters.length === 0) return base;

      if (rule.matchType === 'ALL') {
        return { ...base, AND: filters };
      }

      return { ...base, OR: filters };
    });

    // Products that match ANY of the rules
    const products = await this.prisma.product.findMany({
      where: {
        OR: ruleConditions,
      },
      include: {
        images: { where: { isPrimary: true }, take: 1 },
        brand: true,
        variants: { where: { isActive: true }, take: 1 },
      },
      take: 50, // safety limit for preview
      orderBy: { createdAt: 'desc' },
    });

    return {
      data: products,
      count: products.length,
    };
  }

  // ═════════════════════════════════════════════════
  //   HELPERS
  // ═════════════════════════════════════════════════

  private async ensureCampaignExists(id: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      select: { id: true, status: true, isActive: true },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign "${id}" not found`);
    }

    return campaign;
  }

  private async ensureCampaignExistsAndActive(id: string) {
    const campaign = await this.ensureCampaignExists(id);

    if (campaign.status === 'ARCHIVED' || !campaign.isActive) {
      throw new ForbiddenException(
        'Cannot modify an archived or inactive campaign',
      );
    }

    return campaign;
  }

  private async ensureSectionExists(id: string) {
    const section = await this.prisma.campaignSection.findUnique({
      where: { id },
      select: { id: true, campaignId: true },
    });

    if (!section) {
      throw new NotFoundException(`Section "${id}" not found`);
    }

    return section;
  }

  private async ensureBannerExists(id: string) {
    const banner = await this.prisma.campaignBanner.findUnique({
      where: { id },
      select: { id: true, campaignId: true },
    });

    if (!banner) {
      throw new NotFoundException(`Banner "${id}" not found`);
    }

    return banner;
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

    // Re-throw known HTTP exceptions
    if (
      error instanceof NotFoundException ||
      error instanceof ConflictException ||
      error instanceof BadRequestException ||
      error instanceof ForbiddenException
    ) {
      throw error;
    }

    // Unexpected error
    throw error;
  }
}
