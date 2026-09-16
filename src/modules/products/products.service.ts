import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  AddProductImagesDto,
  AddVariantDto,
  CreateProductDto,
  ProductQueryDto,
} from './dto/product.dto';
import { createSlug, generateSlugWithUUID } from 'src/common/utils/slug.util';
// import { Prisma } from '@prisma/client';
import {
  Decimal,
  PrismaClientKnownRequestError,
} from '@prisma/client/runtime/client';
import { ProductWhereInput } from 'src/generated/prisma/models/Product';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  private async validateOptionValueIds(
    optionIds: string[],
    variants: CreateProductDto['variants'],
  ): Promise<void> {
    const allValueIds = [
      ...new Set(variants.flatMap((v) => v.optionValueIds ?? [])),
    ];

    if (!allValueIds.length) return;

    // 1. Fetch all from DB in one query
    const dbValues = await this.prisma.optionValue.findMany({
      where: { id: { in: allValueIds } },
      select: { id: true, optionId: true },
    });

    // 1. Values exist in DB
    if (dbValues.length !== allValueIds.length) {
      const foundIds = new Set(dbValues.map((v) => v.id));
      const missing = allValueIds.filter((id) => !foundIds.has(id));
      throw new BadRequestException(
        `Option values not found: ${missing.join(', ')}`,
      );
    }

    // Build lookup: valueId → optionId
    const valueToOptionId = new Map(dbValues.map((v) => [v.id, v.optionId]));
    const declaredOptionIds = new Set(optionIds);

    // 2. Values belong to declared optionIds
    for (const { id, optionId } of dbValues) {
      if (!declaredOptionIds.has(optionId)) {
        throw new BadRequestException(
          `Option value "${id}" belongs to undeclared option "${optionId}"`,
        );
      }
    }

    // 3 & 4. Per-variant checks
    const variantCombinations = new Set<string>();

    for (const variant of variants) {
      const valueIds = variant.optionValueIds ?? [];
      const seenOptionIds = new Map<string, string>(); // optionId → valueId

      // 3. Exactly one value per option
      for (const valueId of valueIds) {
        const optionId = valueToOptionId.get(valueId)!;

        if (seenOptionIds.has(optionId)) {
          throw new BadRequestException(
            `Variant "${variant.sku}" has duplicate values for option "${optionId}"`,
          );
        }
        seenOptionIds.set(optionId, valueId);
      }

      // 3. All declared options must be covered
      for (const optionId of declaredOptionIds) {
        if (!seenOptionIds.has(optionId)) {
          throw new BadRequestException(
            `Variant "${variant.sku}" is missing a value for option "${optionId}"`,
          );
        }
      }

      // 4. No duplicate combinations across variants
      const combo = [...valueIds].sort().join('|');
      if (variantCombinations.has(combo)) {
        throw new BadRequestException(
          `Variant "${variant.sku}" has a duplicate option combination`,
        );
      }
      variantCombinations.add(combo);
    }
  }

  async createProduct(data: CreateProductDto) {
    const { slug: providedSlug, name, ...productData } = data;

    const baseSlug = createSlug(data.slug ?? data.name);

    const slugTaken = await this.prisma.product.findUnique({
      where: { slug: baseSlug },
      select: { id: true },
    });

    let slug: string;

    if (slugTaken) {
      if (data.slug ?? data.name) {
        throw new ConflictException(`Slug '${baseSlug}' is already taken`);
      }

      slug = generateSlugWithUUID(data.slug ?? data.name);
    } else {
      slug = baseSlug;
    }

    // Rare race condition still possible → caught as P2002 below
    // const slug = slugTaken ? generateSlugWithUUID(data.name) : baseSlug;

    //-----------------VALIDATIONS if id exists---------------------------

    if (data.brandId) {
      const brand = await this.prisma.brand.findUnique({
        where: {
          id: data.brandId,
        },
      });

      if (!brand) {
        throw new BadRequestException(`Brand ${data.brandId} not found`);
      }
    }

    if (data.categoryIds?.length) {
      const uniqueIds = [...new Set(data.categoryIds)];

      const found = await this.prisma.category.count({
        where: {
          id: {
            in: uniqueIds,
          },
        },
      });

      if (found !== uniqueIds.length) {
        throw new BadRequestException(
          `Some categories not found. Provided: ${uniqueIds.length}, Found: ${found}`,
        );
      }
    }

    if (data.tagIds?.length) {
      const uniqueIds = [...new Set(data.tagIds)];

      const found = await this.prisma.tag.count({
        where: {
          id: {
            in: uniqueIds,
          },
        },
      });

      if (found !== uniqueIds.length) {
        throw new BadRequestException(
          `Some tags not found. Provided: ${uniqueIds.length}, Found: ${found}`,
        );
      }
    }

    if (data.optionIds?.length) {
      const uniqueIds = [...new Set(data.optionIds)];

      const found = await this.prisma.option.count({
        where: {
          id: {
            in: uniqueIds,
          },
        },
      });

      if (found !== uniqueIds.length) {
        throw new BadRequestException(
          `Some options not found. Provided: ${uniqueIds.length}, Found: ${found}`,
        );
      }
    }

    if (data.optionIds?.length) {
      const variantsWithoutValues = data.variants.filter(
        (v) => !v.optionValueIds?.length,
      );
      if (variantsWithoutValues.length) {
        throw new BadRequestException(
          `All variants must have optionValueIds when options are provided. ` +
            `Missing on SKUs: ${variantsWithoutValues.map((v) => v.sku).join(', ')}`,
        );
      }
    }

    //-----------------END---------------------------

    try {
      return await this.prisma.$transaction(async (tx) => {
        // ── Core product ──
        const product = await tx.product.create({
          data: {
            name: data.name,
            slug,
            description: data.description ?? '',
            shortDescription: data.shortDescription ?? '',
            isActive: data.isActive ?? true,
            status: data.status ?? 'DRAFT',
            brandId: data.brandId,
          },
        });

        // ── Product images ──
        // First image is primary by default
        if (data.images?.length) {
          await tx.productImage.createMany({
            data: data.images.map((img, index) => ({
              productId: product.id,
              url: img.url,
              altText: img.altText ?? null,
              isPrimary: img.isPrimary ?? index === 0,
              position: img.position ?? index,
            })),
          });
        }

        // ── Categories ──
        if (data.categoryIds?.length) {
          await tx.productCategory.createMany({
            data: data.categoryIds.map((categoryId) => ({
              productId: product.id,
              categoryId,
            })),
          });
        }

        // ── Tags ──
        if (data.tagIds?.length) {
          await tx.productTag.createMany({
            data: data.tagIds.map((tagId) => ({
              productId: product.id,
              tagId,
            })),
          });
        }

        // ── Options ──
        if (data.optionIds?.length) {
          await tx.productOption.createMany({
            data: data.optionIds.map((optionId) => ({
              productId: product.id,
              optionId,
            })),
          });
        }

        // ── Variants ──
        // Guaranteed to have at least 1 by DTO validation
        for (const v of data.variants) {
          const variant = await tx.productVariant.create({
            data: {
              productId: product.id,
              sku: v.sku,
              // Explicit Decimal — prevents JS float precision drift
              // price: new Prisma.Decimal(v.price),
              price: new Decimal(v.price),
              stock: v.stock ?? 0,
              isActive: v.isActive ?? true,
            },
          });

          // Link option values → e.g. [val-red-uuid, val-s-uuid]
          // Optional — simple products (Water Bottle) have no option values
          if (v.optionValueIds?.length) {
            await tx.variantOptionValue.createMany({
              data: v.optionValueIds.map((optionValueId) => ({
                variantId: variant.id,
                optionValueId,
              })),
            });
          }

          // Variant-specific images (optional)
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

        // ── Return full product ──
        return tx.product.findUnique({
          where: { id: product.id },
          include: {
            brand: true,
            categories: { include: { category: true } },
            tags: { include: { tag: true } },
            options: { include: { option: { include: { values: true } } } },
            images: true,
            variants: {
              include: {
                optionValues: {
                  include: { optionValue: { include: { option: true } } },
                },
                images: true,
              },
            },
          },
        });
      });
    } catch (e: unknown) {
      // ── Prisma unique constraint ──
      if (e instanceof PrismaClientKnownRequestError) {
        if (e.code === 'P2002') {
          const field =
            (e.meta?.target as string[] | undefined)?.join(', ') ??
            'unknown field';

          throw new ConflictException(
            `Duplicate value on unique field: ${field}`,
          );
        }

        if (e.code === 'P2025') {
          throw new BadRequestException('Record not found');
        }
      }

      // ── NestJS HTTP exceptions ──
      if (e instanceof Error && 'getStatus' in e) {
        throw e;
      }

      // ── Fallback unknown error ──
      throw new InternalServerErrorException(
        'Product creation failed unexpectedly',
      );
    }
  }

  async findAll(query: ProductQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const where: ProductWhereInput = {
      status: query.status,
      isActive: query.isActive,
      brandId: query.brandId,
    };

    const [total, products] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
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
            select: {
              id: true,
              name: true,
              slug: true,
              logoUrl: true,
            },
          },

          categories: {
            select: {
              category: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                },
              },
            },
          },

          tags: {
            select: {
              tag: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                },
              },
            },
          },

          images: {
            where: { isPrimary: true },
            select: {
              id: true,
              url: true,
              altText: true,
              isPrimary: true,
            },
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
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  async findOneById(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        brand: true,
        categories: { include: { category: true } },
        tags: { include: { tag: true } },
        options: { include: { option: { include: { values: true } } } },
        images: true,
        variants: {
          include: {
            optionValues: {
              include: { optionValue: { include: { option: true } } },
            },
            images: true,
          },
        },
      },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async findOneBySlug(slug: string) {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      include: {
        brand: true,
        categories: { include: { category: true } },
        tags: { include: { tag: true } },
        options: { include: { option: { include: { values: true } } } },
        images: true,
        variants: {
          include: {
            optionValues: {
              include: { optionValue: { include: { option: true } } },
            },
            images: true,
          },
        },
      },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async removeProduct(id: string) {
    try {
      const product = await this.prisma.product.update({
        where: { id },
        data: {
          deletedAt: new Date(),
        },
      });

      return {
        message: 'Product deleted successfully',
        product,
      };
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Product not found');
      }

      throw error;
    }
  }

  // ── POST /products/:id/images ─────────────────────
  async addProductImages(productId: string, data: AddProductImagesDto) {
    try {
      const existingCount = await this.prisma.productImage.count({
        where: { productId },
      });

      await this.prisma.productImage.createMany({
        data: data.images.map((img, index) => ({
          productId,
          url: img.url,
          altText: img.altText ?? null,
          isPrimary: img.isPrimary ?? existingCount + index === 0,
          position: img.position ?? existingCount + index,
        })),
      });

      return this.prisma.productImage.findMany({
        where: { productId },
        orderBy: { position: 'asc' },
      });
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Product not found');
      }

      throw error;
    }
  }

  async removeProductImage(productId: string, imageId: string) {
    try {
      const image = await this.prisma.productImage.findUnique({
        where: { id: imageId },
        select: { id: true, productId: true, isPrimary: true, position: true },
      });

      await this.prisma.productImage.delete({
        where: { id: imageId },
      });

      if (image?.isPrimary) {
        const nextImage = await this.prisma.productImage.findFirst({
          where: { productId },
          orderBy: { position: 'asc' },
          select: { id: true },
        });

        if (nextImage) {
          await this.prisma.productImage.update({
            where: { id: nextImage.id },
            data: { isPrimary: true },
          });
        }
      }
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Image not found');
      }
    }
  }

  async reorderProductImages() {
    //todo
  }

  async addVariant(id: string, dto: AddVariantDto) {
    // If product has options → validate optionValueIds
    const productOptions = await this.prisma.productOption.findMany({
      where: { productId: id },
      select: { optionId: true },
    });

    if (productOptions.length) {
      const optionIds = productOptions.map((o) => o.optionId);

      if (!dto.optionValueIds?.length) {
        throw new BadRequestException(
          'This product has options — variant must include optionValueIds',
        );
      }

      // Reuse existing deep validation
      await this.validateOptionValueIds(optionIds, [
        { sku: dto.sku, optionValueIds: dto.optionValueIds },
      ]);

      // Check combination not already used by existing variants
      const existingVariants = await this.prisma.productVariant.findMany({
        where: { productId: id },
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
          productId: id,
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
          optionValues: { include: { optionValue: true } },
          images: true,
        },
      });
    });
  }
}
