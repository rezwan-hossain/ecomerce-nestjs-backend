// Builders for pricing unit tests. Defaults describe a live, sitewide 10% promotion.

import { Decimal } from '@prisma/client/runtime/client';
import {
  ResolvedPromotion,
  VariantPricingData,
} from '../interfaces/pricing.types';

export const money = (value: number | string) => new Decimal(value);

export function makePromotion(
  overrides: Partial<ResolvedPromotion> = {},
): ResolvedPromotion {
  return {
    id: 'promo',
    name: 'Promo',
    type: 'PERCENTAGE',
    status: 'ACTIVE',
    value: money(10),
    buyQuantity: null,
    getQuantity: null,
    minOrderAmount: null,
    maxDiscountAmount: null,
    priority: 0,
    startsAt: null,
    endsAt: null,
    isActive: true,
    scope: 'ALL',
    targets: [],
    campaigns: [],
    campaignId: null,
    matchSpecificity: 10,
    ...overrides,
  };
}

export function makeVariant(
  id: string,
  price: number | string,
  overrides: Partial<VariantPricingData> = {},
): VariantPricingData {
  return {
    id,
    sku: id.toUpperCase(),
    name: id,
    price: money(price),
    stock: 100,
    isActive: true,
    productId: `product-${id}`,
    product: {
      id: `product-${id}`,
      name: `Product ${id}`,
      slug: `product-${id}`,
      isActive: true,
      status: 'ACTIVE',
      deletedAt: null,
      brandId: null,
      categories: [],
      tags: [],
    },
    ...overrides,
  };
}
