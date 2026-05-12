import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateProductDto } from './dto/product.dto';
import { createSlug, generateSlugWithUUID } from 'src/common/utils/slug.util';
// import { Prisma } from '@prisma/client';
import {
  Decimal,
  PrismaClientKnownRequestError,
} from '@prisma/client/runtime/client';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  async createProduct(data: CreateProductDto) {
    const { slug: providedSlug, name, ...productData } = data;

    const baseSlug = createSlug(data.slug ?? data.name);

    const slugTaken = await this.prisma.product.findUnique({
      where: { slug: baseSlug },
      select: { id: true },
    });

    // Rare race condition still possible → caught as P2002 below
    const slug = slugTaken ? generateSlugWithUUID(data.name) : baseSlug;

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
}
