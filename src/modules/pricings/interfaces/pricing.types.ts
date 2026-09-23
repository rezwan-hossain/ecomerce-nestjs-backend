// src/modules/pricing/interfaces/pricing.types.ts

import { Decimal } from '@prisma/client/runtime/client';
import {
  CampaignStatus,
  ProductStatus,
  PromotionStatus,
  PromotionTargetType,
  PromotionType,
} from 'src/generated/prisma/enums';

// ═══════════════════════════════════════════════════════════════
//  INPUT TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Context for pricing decisions. Passed to every PricingService method.
 */
export interface PricingContext {
  /** Authenticated user ID (null for guests) */
  userId?: string | null;

  /** Customer role for future role-based pricing */
  customerRole?: string;

  /**
   * Cart subtotal BEFORE discounts. Set automatically by cart/checkout pricing.
   * When undefined (product pages), promotions with a minOrderAmount are NOT
   * applied, so we never display a price the customer can't actually get.
   */
  cartSubtotal?: Decimal;

  /** Total units in the cart (sum of quantities, not number of lines) */
  cartItemCount?: number;

  /** Campaign being browsed. Used to attribute campaign-linked promotions. */
  activeCampaignId?: string;

  /** Currency code */
  currency?: string;

  /** Single clock for the whole calculation (defaults to now) */
  timestamp?: Date;
}

/** What the client sends at checkout: IDs and quantities only, never prices. */
export interface CartLine {
  variantId: string;
  quantity: number;
}

/** A single line item to be priced. */
export interface PricableItem {
  /** @deprecated The engine reads `variant.id`. Kept for backwards compatibility. */
  variantId?: string;

  /** Quantity in cart (positive integer) */
  quantity: number;

  /** Pre-loaded variant data. Build it with VARIANT_PRICING_INCLUDE + toVariantPricingData. */
  variant: VariantPricingData;
}

/**
 * Pre-loaded variant data needed for pricing.
 * Always build via `toVariantPricingData()` so every consumer sends the same shape.
 */
export interface VariantPricingData {
  id: string;
  sku: string;
  /** Label built from option values, e.g. "Red / XL". Falls back to the SKU. */
  name: string;
  price: Decimal;
  stock: number;
  isActive: boolean;
  productId: string;
  product: {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    status: ProductStatus;
    deletedAt: Date | null;
    brandId: string | null;
    categories: Array<{ categoryId: string }>;
    tags: Array<{ tagId: string }>;
  };
}

// ═══════════════════════════════════════════════════════════════
//  PROMOTION TYPES (Internal Engine Representation)
// ═══════════════════════════════════════════════════════════════

export interface ResolvedCampaign {
  id: string;
  status: CampaignStatus;
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  archivedAt: Date | null;
}

/** Fully resolved promotion with targets. Produced by PromotionResolver. */
export interface ResolvedPromotion {
  id: string;
  name: string;
  type: PromotionType;
  status: PromotionStatus;
  value: Decimal | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  minOrderAmount: Decimal | null;
  maxDiscountAmount: Decimal | null;
  priority: number;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;

  /** How this promotion targets products */
  targets: ResolvedTarget[];

  /** Every campaign this promotion is linked to (empty = standalone promotion) */
  campaigns: ResolvedCampaign[];

  /** The live campaign this promotion is applied under for the current request */
  campaignId: string | null;

  /** Computed match score for sorting (per variant) */
  matchSpecificity: number;
}

export interface ResolvedTarget {
  id: string;
  targetType: PromotionTargetType;
  productId: string | null;
  variantId: string | null;
  categoryId: string | null;
  brandId: string | null;
  tagId: string | null;
}

// ═══════════════════════════════════════════════════════════════
//  OUTPUT TYPES
// ═══════════════════════════════════════════════════════════════

/** The result of pricing a single line. */
export interface ItemPriceResult {
  variantId: string;
  sku: string;
  quantity: number;

  /** Original price before any discounts */
  originalUnitPrice: Decimal;

  /** originalUnitPrice × quantity */
  originalLineTotal: Decimal;

  /** The single item-level discount applied (if any) */
  appliedDiscount: AppliedDiscount | null;

  /** Discount amount for this line (2dp) */
  discountAmount: Decimal;

  /** effectiveLineTotal / quantity, rounded. Informational only. */
  effectiveUnitPrice: Decimal;

  /** originalLineTotal − discountAmount. The source of truth for totals. */
  effectiveLineTotal: Decimal;

  /** Human-readable price label */
  priceLabel: string;

  /** Whether this item has an active promotion */
  hasPromotion: boolean;
}

/** The result of pricing an entire cart. */
export interface CartPriceResult {
  items: ItemPriceResult[];

  /** Sum of all originalLineTotal */
  subtotal: Decimal;

  /** Sum of all item-level discountAmount */
  itemDiscountTotal: Decimal;

  /** subtotal − itemDiscountTotal */
  discountedSubtotal: Decimal;

  /** Order-level discounts (currently only shipping) */
  orderDiscounts: AppliedDiscount[];

  /** Total of orderDiscounts (already reflected in effectiveShipping) */
  orderDiscountTotal: Decimal;

  /** Shipping before shipping discounts */
  shippingAmount: Decimal;

  /** Shipping after shipping discounts */
  effectiveShipping: Decimal;

  /** discountedSubtotal + effectiveShipping */
  totalAmount: Decimal;

  currency: string;

  /** All promotions that were applied */
  appliedPromotions: AppliedDiscount[];

  /** Promotions evaluated but not applied (for debugging / admin) */
  skippedPromotions: SkippedPromotion[];
}

/** A discount that was actually applied. */
export interface AppliedDiscount {
  promotionId: string;
  promotionName: string;
  promotionType: PromotionType;
  targetDescription: string; // e.g. "20% off"
  discountAmount: Decimal;
  isOrderLevel: boolean;
  /** Variant the discount was applied to (null for order/shipping discounts) */
  variantId: string | null;
  campaignId: string | null;
}

/** A promotion that was evaluated but not applied. */
export interface SkippedPromotion {
  promotionId: string;
  promotionName: string;
  reason: SkipReason;
}

export enum SkipReason {
  NOT_ACTIVE = 'NOT_ACTIVE',
  OUTSIDE_DATE_RANGE = 'OUTSIDE_DATE_RANGE',
  CAMPAIGN_NOT_LIVE = 'CAMPAIGN_NOT_LIVE',
  MIN_ORDER_NOT_MET = 'MIN_ORDER_NOT_MET',
  NO_MATCHING_TARGETS = 'NO_MATCHING_TARGETS',
  OUTPRIORITIZED = 'OUTPRIORITIZED',
  STACKING_CONFLICT = 'STACKING_CONFLICT',
  ZERO_DISCOUNT = 'ZERO_DISCOUNT',
  MAX_DISCOUNT_REACHED = 'MAX_DISCOUNT_REACHED',
}

/**
 * Frozen price snapshot for one order line.
 * Field names map 1:1 onto the OrderItem model.
 */
export interface PriceSnapshot {
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  variantName: string;
  quantity: number;

  /** → OrderItem.unitPrice (original, pre-discount) */
  unitPrice: Decimal;
  /** → OrderItem.subtotalAmount */
  subtotalAmount: Decimal;
  /** → OrderItem.discountAmount (whole line, not per unit) */
  discountAmount: Decimal;
  /** → OrderItem.totalAmount */
  totalAmount: Decimal;
  /** Informational; store in OrderItem.metadata if useful */
  effectiveUnitPrice: Decimal;

  appliedPromotion: {
    id: string;
    name: string;
    type: PromotionType;
    campaignId: string | null;
  } | null;

  currency: string;
  calculatedAt: Date;
}

/** Everything OrderService needs, from ONE calculation. */
export interface OrderPricing {
  totals: CartPriceResult;
  snapshots: PriceSnapshot[];
  calculatedAt: Date;
}

// ═══════════════════════════════════════════════════════════════
//  RULES & CONSTANTS
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_CURRENCY = 'BDT';

export enum DiscountLevel {
  ITEM = 'ITEM', // Applied per line item
  ORDER = 'ORDER', // Applied to order total
  SHIPPING = 'SHIPPING', // Applied to shipping
}

/** Maps promotion types to their discount level (determines stacking). */
export const PROMOTION_LEVEL_MAP: Record<PromotionType, DiscountLevel> = {
  PERCENTAGE: DiscountLevel.ITEM,
  FIXED_AMOUNT: DiscountLevel.ITEM,
  FIXED_PRICE: DiscountLevel.ITEM,
  BUY_X_GET_Y: DiscountLevel.ITEM,
  FREE_SHIPPING: DiscountLevel.SHIPPING,
  SHIPPING_DISCOUNT: DiscountLevel.SHIPPING,
};

/** Stacking rules: which levels can coexist on the same item/order. */
export const STACKING_RULES = {
  maxItemLevelPerVariant: 1,
  orderStacksWithItem: true,
  shippingStacksWithItem: true,
  maxShippingLevel: 1,
  floorAtZero: true,
} as const;

/** Tie-break scores when priorities are equal. Higher = more specific. */
export const TARGET_SPECIFICITY: Record<PromotionTargetType, number> = {
  VARIANT: 100,
  PRODUCT: 80,
  TAG: 60,
  BRAND: 50,
  CATEGORY: 40,
  ALL_PRODUCTS: 10,
};

/** Added once (not per target) when a matching promotion runs under a live campaign. */
export const CAMPAIGN_SPECIFICITY_BONUS = 5;

/** TODO: replace with a real shipping-rate engine (zones, weight, courier). */
export const SHIPPING_RULES = {
  /** Compared against the DISCOUNTED subtotal (what the customer actually pays) */
  freeShippingThreshold: new Decimal(5000),
  flatRate: new Decimal(120),
} as const;
