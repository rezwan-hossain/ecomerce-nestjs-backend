import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  Decimal,
  PrismaClientKnownRequestError,
} from '@prisma/client/runtime/client';
import { ProductWhereInput } from 'src/generated/prisma/models/Product';

import { createSlug, generateSlugWithUUID } from 'src/common/utils/slug.util';

import {
  CreateProductDto,
  UpdateProductDto,
  ProductQueryDto,
} from './dto/product.dto';
import {
  AddProductImagesDto,
  UpdateProductImageDto,
  ReorderProductImagesDto,
} from './dto/product-image.dto';
import {
  AddVariantDto,
  UpdateVariantDto,
  AdjustStockDto,
} from './dto/product-variant.dto';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  // ═════════════════════════════════════════════════
  //   INTERNAL VALIDATORS
  // ═════════════════════════════════════════════════

  private async validateBrand(brandId?: string | null) {
    if (!brandId) return;
    const exists = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true },
    });
    if (!exists) throw new BadRequestException(`Brand "${brandId}" not found`);
  }

  private async validateCategories(categoryIds?: string[]) {
    if (!categoryIds?.length) return;
    const uniqueIds = [...new Set(categoryIds)];
    const count = await this.prisma.category.count({
      where: { id: { in: uniqueIds } },
    });
    if (count !== uniqueIds.length) {
      throw new BadRequestException(
        `Some categories not found. Provided: ${uniqueIds.length}, Found: ${count}`,
      );
    }
  }

  private async validateTags(tagIds?: string[]) {
    if (!tagIds?.length) return;
    const uniqueIds = [...new Set(tagIds)];
    const count = await this.prisma.tag.count({
      where: { id: { in: uniqueIds } },
    });
    if (count !== uniqueIds.length) {
      throw new BadRequestException(
        `Some tags not found. Provided: ${uniqueIds.length}, Found: ${count}`,
      );
    }
  }

  private async validateOptions(optionIds?: string[]) {
    if (!optionIds?.length) return;
    const uniqueIds = [...new Set(optionIds)];
    const count = await this.prisma.option.count({
      where: { id: { in: uniqueIds } },
    });
    if (count !== uniqueIds.length) {
      throw new BadRequestException(
        `Some options not found. Provided: ${uniqueIds.length}, Found: ${count}`,
      );
    }
  }

  private async validateOptionValueIds(
    optionIds: string[],
    variants: Array<{ sku: string; optionValueIds?: string[] }>,
  ): Promise<void> {
    const allValueIds = [
      ...new Set(variants.flatMap((v) => v.optionValueIds ?? [])),
    ];
    if (!allValueIds.length) return;

    const dbValues = await this.prisma.optionValue.findMany({
      where: { id: { in: allValueIds } },
      select: { id: true, optionId: true },
    });

    if (dbValues.length !== allValueIds.length) {
      const foundIds = new Set(dbValues.map((v) => v.id));
      const missing = allValueIds.filter((id) => !foundIds.has(id));
      throw new BadRequestException(
        `Option values not found: ${missing.join(', ')}`,
      );
    }

    const valueToOptionId = new Map(dbValues.map((v) => [v.id, v.optionId]));
    const declaredOptionIds = new Set(optionIds);

    for (const { id, optionId } of dbValues) {
      if (!declaredOptionIds.has(optionId)) {
        throw new BadRequestException(
          `Option value "${id}" belongs to undeclared option "${optionId}"`,
        );
      }
    }

    const variantCombinations = new Set<string>();

    for (const variant of variants) {
      const valueIds = variant.optionValueIds ?? [];
      const seenOptionIds = new Map<string, string>();

      for (const valueId of valueIds) {
        const optionId = valueToOptionId.get(valueId)!;
        if (seenOptionIds.has(optionId)) {
          throw new BadRequestException(
            `Variant "${variant.sku}" has duplicate values for option "${optionId}"`,
          );
        }
        seenOptionIds.set(optionId, valueId);
      }

      for (const optionId of declaredOptionIds) {
        if (!seenOptionIds.has(optionId)) {
          throw new BadRequestException(
            `Variant "${variant.sku}" is missing a value for option "${optionId}"`,
          );
        }
      }

      const combo = [...valueIds].sort().join('|');
      if (variantCombinations.has(combo)) {
        throw new BadRequestException(
          `Variant "${variant.sku}" has a duplicate option combination`,
        );
      }
      variantCombinations.add(combo);
    }
  }

  private async resolveUniqueSlug(input: string): Promise<string> {
    const base = createSlug(input);
    const exists = await this.prisma.product.findUnique({
      where: { slug: base },
      select: { id: true },
    });
    return exists ? generateSlugWithUUID(input) : base;
  }

  // ═════════════════════════════════════════════════
  //   CREATE
  // ═════════════════════════════════════════════════

  async createProduct(dto: CreateProductDto) {
    // Slug resolution
    const providedSlug = dto.slug ?? dto.name;
    let slug = createSlug(providedSlug);

    const slugTaken = await this.prisma.product.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (slugTaken) {
      if (dto.slug) {
        throw new ConflictException(`Slug '${slug}' is already taken`);
      }
      slug = generateSlugWithUUID(dto.name);
    }

    // Cross-entity validations
    await this.validateBrand(dto.brandId);
    await this.validateCategories(dto.categoryIds);
    await this.validateTags(dto.tagIds);
    await this.validateOptions(dto.optionIds);

    if (
      dto.primaryCategoryId &&
      !dto.categoryIds?.includes(dto.primaryCategoryId)
    ) {
      throw new BadRequestException(
        'primaryCategoryId must be included in categoryIds',
      );
    }

    if (dto.optionIds?.length) {
      const missing = dto.variants.filter((v) => !v.optionValueIds?.length);
      if (missing.length) {
        throw new BadRequestException(
          `All variants must have optionValueIds when options are provided. Missing on SKUs: ${missing.map((v) => v.sku).join(', ')}`,
        );
      }
      await this.validateOptionValueIds(dto.optionIds, dto.variants);
    }

    // SKU uniqueness check across ALL products
    const skus = dto.variants.map((v) => v.sku);
    const existingSkus = await this.prisma.productVariant.findMany({
      where: { sku: { in: skus } },
      select: { sku: true },
    });
    if (existingSkus.length > 0) {
      throw new ConflictException(
        `SKUs already exist: ${existingSkus.map((s) => s.sku).join(', ')}`,
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const product = await tx.product.create({
          data: {
            name: dto.name,
            slug,
            description: dto.description ?? '',
            shortDescription: dto.shortDescription ?? '',
            isActive: dto.isActive ?? true,
            status: dto.status ?? 'DRAFT',
            brandId: dto.brandId,
          },
        });

        // Images
        if (dto.images?.length) {
          await tx.productImage.createMany({
            data: dto.images.map((img, index) => ({
              productId: product.id,
              url: img.url,
              altText: img.altText ?? null,
              isPrimary: img.isPrimary ?? index === 0,
              position: img.position ?? index,
            })),
          });
        }

        // Categories with primary designation
        if (dto.categoryIds?.length) {
          await tx.productCategory.createMany({
            data: dto.categoryIds.map((categoryId) => ({
              productId: product.id,
              categoryId,
              isPrimary: dto.primaryCategoryId === categoryId,
            })),
          });
        }

        // Tags
        if (dto.tagIds?.length) {
          await tx.productTag.createMany({
            data: dto.tagIds.map((tagId) => ({
              productId: product.id,
              tagId,
            })),
          });
        }

        // Options
        if (dto.optionIds?.length) {
          await tx.productOption.createMany({
            data: dto.optionIds.map((optionId) => ({
              productId: product.id,
              optionId,
            })),
          });
        }

        // Variants
        for (const v of dto.variants) {
          const variant = await tx.productVariant.create({
            data: {
              productId: product.id,
              sku: v.sku,
              price: new Decimal(v.price),
              stock: v.stock ?? 0,
              isActive: v.isActive ?? true,
            },
          });

          if (v.optionValueIds?.length) {
            await tx.variantOptionValue.createMany({
              data: v.optionValueIds.map((optionValueId) => ({
                variantId: variant.id,
                optionValueId,
              })),
            });
          }

          if (v.images?.length) {
            await tx.variantImage.createMany({
              data: v.images.map((img, index) => ({
                variantId: variant.id,
                url: img.url,
                altText: img.altText ?? null,
                isPrimary: img.isPrimary ?? index === 0,
                position: img.position ?? index,
              })),
            });
          }
        }

        return tx.product.findUnique({
          where: { id: product.id },
          include: this.fullProductInclude(),
        });
      });
    } catch (e) {
      this.handlePrismaError(e, 'Product');
    }
  }

  // ═════════════════════════════════════════════════
  //   LIST
  // ═════════════════════════════════════════════════

  async findAll(query: ProductQueryDto) {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      isActive,
      brandId,
      categoryId,
      tagId,
      minPrice,
      maxPrice,
      includeDeleted,
      sortBy,
      sortOrder,
    } = query;
    const skip = (page - 1) * limit;

    const where: ProductWhereInput = {
      ...(includeDeleted ? {} : { deletedAt: null }),
      ...(status && { status }),
      ...(isActive !== undefined && { isActive }),
      ...(brandId && { brandId }),
    };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (categoryId) {
      where.categories = { some: { categoryId } };
    }
    if (tagId) {
      where.tags = { some: { tagId } };
    }
    if (minPrice !== undefined || maxPrice !== undefined) {
      where.variants = {
        some: {
          isActive: true,
          price: {
            ...(minPrice !== undefined && { gte: minPrice }),
            ...(maxPrice !== undefined && { lte: maxPrice }),
          },
        },
      };
    }

    const [total, products] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          shortDescription: true,
          status: true,
          isActive: true,
          createdAt: true,
          brand: {
            select: { id: true, name: true, slug: true, logoUrl: true },
          },
          categories: {
            select: {
              isPrimary: true,
              category: { select: { id: true, name: true, slug: true } },
            },
          },
          tags: {
            select: { tag: { select: { id: true, name: true, slug: true } } },
          },
          images: {
            where: { isPrimary: true },
            select: { id: true, url: true, altText: true, isPrimary: true },
            take: 1,
          },
          variants: {
            select: {
              id: true,
              sku: true,
              price: true,
              stock: true,
              isActive: true,
            },
          },
        },
      }),
    ]);

    return {
      data: products,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  // ═════════════════════════════════════════════════
  //   FIND ONE
  // ═════════════════════════════════════════════════

  async findOneById(id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: this.fullProductInclude(),
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async findOneBySlug(slug: string) {
    const product = await this.prisma.product.findFirst({
      where: { slug, deletedAt: null },
      include: this.fullProductInclude(),
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  // ═════════════════════════════════════════════════
  //   UPDATE (core fields + relations)
  // ═════════════════════════════════════════════════

  async updateProduct(id: string, dto: UpdateProductDto) {
    await this.ensureProductExists(id);

    // Validate references if provided
    await this.validateBrand(dto.brandId);
    await this.validateCategories(dto.categoryIds);
    await this.validateTags(dto.tagIds);

    if (
      dto.primaryCategoryId &&
      !dto.categoryIds?.includes(dto.primaryCategoryId)
    ) {
      throw new BadRequestException(
        'primaryCategoryId must be included in categoryIds',
      );
    }

    // Slug conflict check
    if (dto.slug) {
      const conflict = await this.prisma.product.findFirst({
        where: { slug: dto.slug, id: { not: id } },
        select: { id: true },
      });
      if (conflict)
        throw new ConflictException(`Slug '${dto.slug}' is already taken`);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Base fields
        await tx.product.update({
          where: { id },
          data: {
            ...(dto.name && { name: dto.name }),
            ...(dto.slug && { slug: dto.slug }),
            ...(dto.description !== undefined && {
              description: dto.description,
            }),
            ...(dto.shortDescription !== undefined && {
              shortDescription: dto.shortDescription,
            }),
            ...(dto.status && { status: dto.status }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
            ...(dto.brandId !== undefined && { brandId: dto.brandId }),
          },
        });

        // Sync categories
        if (dto.categoryIds !== undefined) {
          await tx.productCategory.deleteMany({ where: { productId: id } });
          if (dto.categoryIds.length) {
            await tx.productCategory.createMany({
              data: dto.categoryIds.map((categoryId) => ({
                productId: id,
                categoryId,
                isPrimary: dto.primaryCategoryId === categoryId,
              })),
            });
          }
        }

        // Sync tags
        if (dto.tagIds !== undefined) {
          await tx.productTag.deleteMany({ where: { productId: id } });
          if (dto.tagIds.length) {
            await tx.productTag.createMany({
              data: dto.tagIds.map((tagId) => ({
                productId: id,
                tagId,
              })),
            });
          }
        }

        return tx.product.findUnique({
          where: { id },
          include: this.fullProductInclude(),
        });
      });
    } catch (e) {
      this.handlePrismaError(e, 'Product');
    }
  }

  // ═════════════════════════════════════════════════
  //   STATUS TRANSITIONS
  // ═════════════════════════════════════════════════

  async publish(id: string) {
    await this.ensureProductExists(id);

    const variantCount = await this.prisma.productVariant.count({
      where: { productId: id, isActive: true },
    });
    if (variantCount === 0) {
      throw new BadRequestException(
        'Cannot publish product without at least one active variant',
      );
    }

    const product = await this.prisma.product.update({
      where: { id },
      data: { status: 'ACTIVE', isActive: true },
    });
    return { message: 'Product published', data: product };
  }

  async archive(id: string) {
    await this.ensureProductExists(id);
    const product = await this.prisma.product.update({
      where: { id },
      data: { status: 'ARCHIVED', isActive: false },
    });
    return { message: 'Product archived', data: product };
  }

  async unarchive(id: string) {
    await this.ensureProductExists(id, { includeDeleted: true });
    const product = await this.prisma.product.update({
      where: { id },
      data: { status: 'DRAFT', deletedAt: null },
    });
    return { message: 'Product unarchived', data: product };
  }

  // ═════════════════════════════════════════════════
  //   SOFT DELETE / HARD DELETE
  // ═════════════════════════════════════════════════

  async softDelete(id: string) {
    try {
      const product = await this.prisma.product.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
      });
      return { message: 'Product deleted successfully', data: product };
    } catch (e) {
      this.handlePrismaError(e, 'Product');
    }
  }

  async hardDelete(id: string) {
    try {
      await this.prisma.product.delete({ where: { id } });
      return { message: 'Product permanently deleted' };
    } catch (e) {
      this.handlePrismaError(e, 'Product');
    }
  }

  // ═════════════════════════════════════════════════
  //   IMAGES
  // ═════════════════════════════════════════════════

  async addProductImages(productId: string, dto: AddProductImagesDto) {
    await this.ensureProductExists(productId);

    const existingCount = await this.prisma.productImage.count({
      where: { productId },
    });

    await this.prisma.productImage.createMany({
      data: dto.images.map((img, index) => ({
        productId,
        url: img.url,
        altText: img.altText ?? null,
        isPrimary: img.isPrimary ?? (existingCount === 0 && index === 0),
        position: img.position ?? existingCount + index,
      })),
    });

    return this.prisma.productImage.findMany({
      where: { productId },
      orderBy: { position: 'asc' },
    });
  }

  async updateProductImage(
    productId: string,
    imageId: string,
    dto: UpdateProductImageDto,
  ) {
    const image = await this.prisma.productImage.findUnique({
      where: { id: imageId },
      select: { id: true, productId: true },
    });
    if (!image || image.productId !== productId) {
      throw new NotFoundException('Image not found on this product');
    }

    // If setting isPrimary=true → unset others
    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.productImage.updateMany({
          where: { productId, id: { not: imageId } },
          data: { isPrimary: false },
        });
      }

      return tx.productImage.update({
        where: { id: imageId },
        data: { ...dto },
      });
    });
  }

  async removeProductImage(productId: string, imageId: string) {
    const image = await this.prisma.productImage.findUnique({
      where: { id: imageId },
      select: { id: true, productId: true, isPrimary: true },
    });
    if (!image || image.productId !== productId) {
      throw new NotFoundException('Image not found on this product');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.productImage.delete({ where: { id: imageId } });

      if (image.isPrimary) {
        const next = await tx.productImage.findFirst({
          where: { productId },
          orderBy: { position: 'asc' },
          select: { id: true },
        });
        if (next) {
          await tx.productImage.update({
            where: { id: next.id },
            data: { isPrimary: true },
          });
        }
      }
    });

    return { message: 'Image removed' };
  }

  async reorderProductImages(productId: string, dto: ReorderProductImagesDto) {
    await this.ensureProductExists(productId);

    const ids = dto.items.map((i) => i.id);
    const existing = await this.prisma.productImage.findMany({
      where: { id: { in: ids }, productId },
      select: { id: true },
    });
    if (existing.length !== ids.length) {
      throw new BadRequestException(
        'One or more images do not belong to this product',
      );
    }

    await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.productImage.update({
          where: { id: item.id },
          data: { position: item.position },
        }),
      ),
    );

    return { message: 'Images reordered' };
  }

  // ═════════════════════════════════════════════════
  //   VARIANTS
  // ═════════════════════════════════════════════════

  async addVariant(productId: string, dto: AddVariantDto) {
    await this.ensureProductExists(productId);

    // SKU uniqueness
    const skuExists = await this.prisma.productVariant.findUnique({
      where: { sku: dto.sku },
      select: { id: true },
    });
    if (skuExists)
      throw new ConflictException(`SKU '${dto.sku}' already exists`);

    const productOptions = await this.prisma.productOption.findMany({
      where: { productId },
      select: { optionId: true },
    });

    if (productOptions.length) {
      const optionIds = productOptions.map((o) => o.optionId);
      if (!dto.optionValueIds?.length) {
        throw new BadRequestException(
          'This product has options — variant must include optionValueIds',
        );
      }

      await this.validateOptionValueIds(optionIds, [
        { sku: dto.sku, optionValueIds: dto.optionValueIds },
      ]);

      const existingVariants = await this.prisma.productVariant.findMany({
        where: { productId },
        include: { optionValues: true },
      });

      const newCombo = [...dto.optionValueIds].sort().join('|');
      const duplicate = existingVariants.find((v) => {
        const combo = v.optionValues
          .map((ov) => ov.optionValueId)
          .sort()
          .join('|');
        return combo === newCombo;
      });
      if (duplicate) {
        throw new ConflictException(
          `Variant with this option combination already exists (SKU: ${duplicate.sku})`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const variant = await tx.productVariant.create({
        data: {
          productId,
          sku: dto.sku,
          price: new Decimal(dto.price),
          stock: dto.stock ?? 0,
          isActive: dto.isActive ?? true,
        },
      });

      if (dto.optionValueIds?.length) {
        await tx.variantOptionValue.createMany({
          data: dto.optionValueIds.map((optionValueId) => ({
            variantId: variant.id,
            optionValueId,
          })),
        });
      }

      if (dto.images?.length) {
        await tx.variantImage.createMany({
          data: dto.images.map((img, index) => ({
            variantId: variant.id,
            url: img.url,
            altText: img.altText ?? null,
            isPrimary: img.isPrimary ?? index === 0,
            position: img.position ?? index,
          })),
        });
      }

      return tx.productVariant.findUnique({
        where: { id: variant.id },
        include: {
          optionValues: {
            include: { optionValue: { include: { option: true } } },
          },
          images: true,
        },
      });
    });
  }

  async updateVariant(variantId: string, dto: UpdateVariantDto) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, sku: true },
    });
    if (!variant) throw new NotFoundException('Variant not found');

    if (dto.sku && dto.sku !== variant.sku) {
      const skuExists = await this.prisma.productVariant.findUnique({
        where: { sku: dto.sku },
        select: { id: true },
      });
      if (skuExists)
        throw new ConflictException(`SKU '${dto.sku}' already exists`);
    }

    const updated = await this.prisma.productVariant.update({
      where: { id: variantId },
      data: {
        ...(dto.sku && { sku: dto.sku }),
        ...(dto.price !== undefined && { price: new Decimal(dto.price) }),
        ...(dto.stock !== undefined && { stock: dto.stock }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    return { message: 'Variant updated', data: updated };
  }

  async removeVariant(variantId: string) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, productId: true },
    });
    if (!variant) throw new NotFoundException('Variant not found');

    const remaining = await this.prisma.productVariant.count({
      where: { productId: variant.productId },
    });
    if (remaining <= 1) {
      throw new BadRequestException(
        'Cannot delete last variant of a product. Delete the product instead.',
      );
    }

    await this.prisma.productVariant.delete({ where: { id: variantId } });
    return { message: 'Variant removed' };
  }

  async adjustStock(variantId: string, dto: AdjustStockDto) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, stock: true },
    });
    if (!variant) throw new NotFoundException('Variant not found');

    const newStock = variant.stock + dto.delta;
    if (newStock < 0) {
      throw new BadRequestException(
        `Insufficient stock. Current: ${variant.stock}, Delta: ${dto.delta}`,
      );
    }

    const updated = await this.prisma.productVariant.update({
      where: { id: variantId },
      data: { stock: newStock },
    });

    return { message: 'Stock adjusted', data: updated };
  }

  // ═════════════════════════════════════════════════
  //   HELPERS
  // ═════════════════════════════════════════════════

  private async ensureProductExists(
    id: string,
    opts: { includeDeleted?: boolean } = {},
  ) {
    const product = await this.prisma.product.findFirst({
      where: {
        id,
        ...(opts.includeDeleted ? {} : { deletedAt: null }),
      },
      select: { id: true, status: true, isActive: true, deletedAt: true },
    });

    if (!product) throw new NotFoundException(`Product "${id}" not found`);
    return product;
  }

  private fullProductInclude() {
    return {
      brand: true,
      categories: { include: { category: true } },
      tags: { include: { tag: true } },
      options: { include: { option: { include: { values: true } } } },
      images: { orderBy: { position: 'asc' as const } },
      variants: {
        include: {
          optionValues: {
            include: { optionValue: { include: { option: true } } },
          },
          images: { orderBy: { position: 'asc' as const } },
        },
      },
    };
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
      if (error.code === 'P2003') {
        throw new BadRequestException(`${entity} reference constraint failed`);
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

    throw new InternalServerErrorException(
      `${entity} operation failed unexpectedly`,
    );
  }
}
