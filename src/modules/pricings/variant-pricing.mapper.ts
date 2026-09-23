// src/modules/pricing/variant-pricing.mapper.ts

import { Prisma } from 'src/generated/prisma/client';
import { VariantPricingData } from './interfaces/pricing.types';

/**
 * The ONE Prisma include for loading variants that will be priced.
 * CartService / ProductService should reuse this (and toVariantPricingData)
 * instead of hand-building VariantPricingData, so the engine always gets the same shape.
 */
export const VARIANT_PRICING_INCLUDE = {
  product: {
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      status: true,
      deletedAt: true,
      brandId: true,
      categories: { select: { categoryId: true } },
      tags: { select: { tagId: true } },
    },
  },
  optionValues: {
    select: {
      optionValue: {
        select: { value: true, option: { select: { name: true } } },
      },
    },
  },
} satisfies Prisma.ProductVariantInclude;

export type VariantWithPricingRelations = Prisma.ProductVariantGetPayload<{
  include: typeof VARIANT_PRICING_INCLUDE;
}>;

export function toVariantPricingData(
  variant: VariantWithPricingRelations,
): VariantPricingData {
  // Sort by option name so the label is stable ("Color / Size"), not DB-order dependent.
  const label = [...variant.optionValues]
    .sort((a, b) =>
      a.optionValue.option.name.localeCompare(b.optionValue.option.name),
    )
    .map((ov) => ov.optionValue.value)
    .join(' / ');

  const { product } = variant;

  return {
    id: variant.id,
    sku: variant.sku,
    name: label || variant.sku,
    price: variant.price,
    stock: variant.stock,
    isActive: variant.isActive,
    productId: variant.productId,
    product: {
      id: product.id,
      name: product.name,
      slug: product.slug,
      isActive: product.isActive,
      status: product.status,
      deletedAt: product.deletedAt,
      brandId: product.brandId,
      categories: product.categories,
      tags: product.tags,
    },
  };
}

/** A variant can be sold only if it AND its product are live. */
export function isVariantPurchasable(variant: VariantPricingData): boolean {
  return (
    variant.isActive &&
    variant.product.isActive &&
    variant.product.status === 'ACTIVE' &&
    variant.product.deletedAt === null
  );
}
