// src/modules/pricing/pricing.service.ts

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { Prisma } from 'src/generated/prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PromotionResolver } from './promotion-resolver.service';
import {
  DiscountCalculator,
  DiscountCapLedger,
} from './discount-calculator.service';
import {
  VARIANT_PRICING_INCLUDE,
  isVariantPurchasable,
  toVariantPricingData,
} from './variant-pricing.mapper';
import { ZERO, sumDecimals } from '../../../src/common/utils/money.util';
import {
  AppliedDiscount,
  CartLine,
  CartPriceResult,
  DEFAULT_CURRENCY,
  ItemPriceResult,
  OrderPricing,
  PricableItem,
  PriceSnapshot,
  PricingContext,
  SHIPPING_RULES,
  SkipReason,
  SkippedPromotion,
  VariantPricingData,
} from './interfaces/pricing.types';

/**
 * THE AUTHORITATIVE PRICING ENGINE.
 * Every customer-facing price MUST come from this service.
 *
 *   ✅ ProductService  → calculateItemPrice() / calculateBulkPrices()
 *   ✅ CartService     → loadPricableItems() + calculateCartPrices()
 *   ✅ CheckoutService → calculateCheckoutTotals(lines)
 *   ✅ OrderService    → createOrderPricing(lines, ctx, tx)
 *   ❌ Never calculate prices inline elsewhere
 *   ❌ Never trust prices sent by the client
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PromotionResolver,
    private readonly calculator: DiscountCalculator,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  //  DISPLAY PRICES (product pages, listings, campaign sections)
  // ═══════════════════════════════════════════════════════════════

  async calculateItemPrice(
    variantId: string,
    context: PricingContext = {},
  ): Promise<ItemPriceResult> {
    const [variant] = await this.loadVariants([variantId]);
    if (!variant) throw new NotFoundException(`Variant ${variantId} not found`);

    const prices = await this.priceForDisplay([variant], context);
    return prices.get(variant.id)!;
  }

  async calculateBulkPrices(
    variantIds: string[],
    context: PricingContext = {},
  ): Promise<Map<string, ItemPriceResult>> {
    const ids = [...new Set(variantIds)];
    if (ids.length === 0) return new Map();

    const variants = await this.loadVariants(ids);
    return this.priceForDisplay(variants, context);
  }

  // ═══════════════════════════════════════════════════════════════
  //  CART / CHECKOUT / ORDER
  // ═══════════════════════════════════════════════════════════════

  /**
   * Complete cart pricing. Duplicate variants are merged.
   * Does NOT reject unavailable items (the cart UI should show them);
   * checkout and order placement do.
   */
  async calculateCartPrices(
    items: PricableItem[],
    context: PricingContext = {},
  ): Promise<CartPriceResult> {
    const currency = context.currency ?? DEFAULT_CURRENCY;
    const lines = this.mergeItems(items);
    if (lines.length === 0) return this.emptyCartResult(currency);

    // 1. Context enriched with cart data and ONE clock for the whole calculation
    const ctx: PricingContext = {
      ...context,
      timestamp: context.timestamp ?? new Date(),
      cartSubtotal: sumDecimals(lines.map((l) => l.variant.price.mul(l.quantity))),
      cartItemCount: lines.reduce((n, l) => n + l.quantity, 0),
    };

    // 2. Resolve promotions for all lines at once
    const resolution = await this.resolver.resolve(
      lines.map((l) => l.variant),
      ctx,
    );

    const ledger: DiscountCapLedger = new Map();
    const applied: AppliedDiscount[] = [];
    const skipped: SkippedPromotion[] = [...resolution.skipped];

    // 3. Item-level discounts (one per line, caps shared across the order)
    const itemResults = lines.map((line) => {
      const decision = this.calculator.calculateBestItemDiscount(
        line.variant,
        line.quantity,
        resolution.itemLevel.get(line.variant.id) ?? [],
        ledger,
      );
      this.calculator.recordCapUsage(ledger, decision.discount);
      skipped.push(...decision.skipped);
      if (decision.discount) applied.push(decision.discount);

      return this.calculator.buildItemPriceResult(
        line.variant,
        line.quantity,
        decision.discount,
      );
    });

    // 4. Totals
    const subtotal = sumDecimals(itemResults.map((r) => r.originalLineTotal));
    const itemDiscountTotal = sumDecimals(
      itemResults.map((r) => r.discountAmount),
    );
    const discountedSubtotal = subtotal.minus(itemDiscountTotal);

    // 5. Shipping — based on what the customer actually pays
    const shippingAmount = this.calculateBaseShipping(discountedSubtotal);

    // Shipping promos' minOrderAmount is also checked against the discounted subtotal
    const shippingPromos = resolution.shippingLevel.filter((promo) => {
      const ok = !promo.minOrderAmount || discountedSubtotal.gte(promo.minOrderAmount);
      if (!ok) {
        skipped.push({
          promotionId: promo.id,
          promotionName: promo.name,
          reason: SkipReason.MIN_ORDER_NOT_MET,
        });
      }
      return ok;
    });

    const shippingDecision = this.calculator.calculateBestShippingDiscount(
      shippingAmount,
      shippingPromos,
      ledger,
    );
    skipped.push(...shippingDecision.skipped);

    const shippingDiscount = shippingDecision.discount;
    if (shippingDiscount) applied.push(shippingDiscount);

    const effectiveShipping = Decimal.max(
      shippingAmount.minus(shippingDiscount?.discountAmount ?? ZERO),
      ZERO,
    );
    const orderDiscounts = shippingDiscount ? [shippingDiscount] : [];

    // 6. Final total (floored at zero)
    return {
      items: itemResults,
      subtotal,
      itemDiscountTotal,
      discountedSubtotal,
      orderDiscounts,
      orderDiscountTotal: sumDecimals(orderDiscounts.map((d) => d.discountAmount)),
      shippingAmount,
      effectiveShipping,
      totalAmount: Decimal.max(discountedSubtotal.plus(effectiveShipping), ZERO),
      currency,
      appliedPromotions: applied,
      skippedPromotions: this.dedupeSkipped(skipped),
    };
  }

  /**
   * Checkout preview. Takes IDs + quantities only and reloads everything
   * from the DB, so stale or tampered prices can never reach checkout.
   */
  async calculateCheckoutTotals(
    lines: CartLine[],
    context: PricingContext = {},
  ): Promise<CartPriceResult> {
    const items = await this.loadPricableItems(lines);
    this.assertPurchasable(items);
    return this.calculateCartPrices(items, context);
  }

  /**
   * Totals + per-line snapshots from ONE calculation, for order placement.
   * Pass the transaction client so variants are read inside the order transaction.
   */
  async createOrderPricing(
    lines: CartLine[],
    context: PricingContext = {},
    tx?: Prisma.TransactionClient,
  ): Promise<OrderPricing> {
    const calculatedAt = context.timestamp ?? new Date();

    const items = await this.loadPricableItems(lines, tx);
    this.assertPurchasable(items);

    const totals = await this.calculateCartPrices(items, { ...context, timestamp: calculatedAt });

    const variantsById = new Map(items.map((i) => [i.variant.id, i.variant]));
    const snapshots = totals.items.map((result) =>
      this.toSnapshot(variantsById.get(result.variantId)!, result, totals.currency, calculatedAt),
    );

    return { totals, snapshots, calculatedAt };
  }

  /** Load fresh variant data for cart lines. Merges duplicates, validates quantities. */
  async loadPricableItems(
    lines: CartLine[],
    tx?: Prisma.TransactionClient,
  ): Promise<PricableItem[]> {
    const quantities = new Map<string, number>();
    for (const line of lines) {
      this.assertQuantity(line.quantity, line.variantId);
      quantities.set(line.variantId, (quantities.get(line.variantId) ?? 0) + line.quantity);
    }

    const variants = await this.loadVariants([...quantities.keys()], tx);
    const byId = new Map(variants.map((v) => [v.id, v]));

    const missing = [...quantities.keys()].filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(`Variant(s) not found: ${missing.join(', ')}`);
    }

    return [...quantities].map(([variantId, quantity]) => ({
      quantity,
      variant: byId.get(variantId)!,
    }));
  }

  // ═══════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════

  /** Per-unit prices for display; one promotion resolution for all variants. */
  private async priceForDisplay(
    variants: VariantPricingData[],
    context: PricingContext,
  ): Promise<Map<string, ItemPriceResult>> {
    const ctx: PricingContext = { ...context, timestamp: context.timestamp ?? new Date() };
    const { itemLevel } = await this.resolver.resolve(variants, ctx);

    const results = new Map<string, ItemPriceResult>();
    for (const variant of variants) {
      const { discount } = this.calculator.calculateBestItemDiscount(
        variant,
        1,
        itemLevel.get(variant.id) ?? [],
      );
      results.set(variant.id, this.calculator.buildItemPriceResult(variant, 1, discount));
    }
    return results;
  }

  private async loadVariants(
    ids: string[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<VariantPricingData[]> {
    if (ids.length === 0) return [];
    const rows = await db.productVariant.findMany({
      where: { id: { in: ids } },
      include: VARIANT_PRICING_INCLUDE,
    });
    return rows.map(toVariantPricingData);
  }

  private mergeItems(items: PricableItem[]): PricableItem[] {
    const merged = new Map<string, PricableItem>();
    for (const item of items) {
      this.assertQuantity(item.quantity, item.variant.id);
      const existing = merged.get(item.variant.id);
      if (existing) existing.quantity += item.quantity;
      else merged.set(item.variant.id, { variant: item.variant, quantity: item.quantity });
    }
    return [...merged.values()];
  }

  private assertQuantity(quantity: number, variantId: string): void {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new BadRequestException(`Invalid quantity ${quantity} for variant ${variantId}`);
    }
  }

  /** Report ALL problems at once so the customer can fix the cart in one go. */
  private assertPurchasable(items: PricableItem[]): void {
    const errors: string[] = [];
    for (const { variant, quantity } of items) {
      if (!isVariantPurchasable(variant)) {
        errors.push(`"${variant.product.name}" is no longer available`);
      } else if (variant.stock < quantity) {
        errors.push(`Only ${variant.stock} left of "${variant.product.name}" (${variant.name})`);
      }
    }
    if (errors.length > 0) {
      throw new BadRequestException({
        message: 'Some items in your cart cannot be purchased',
        errors,
      });
    }
  }

  private toSnapshot(
    variant: VariantPricingData,
    result: ItemPriceResult,
    currency: string,
    calculatedAt: Date,
  ): PriceSnapshot {
    const promo = result.appliedDiscount;
    return {
      variantId: variant.id,
      productId: variant.productId,
      sku: variant.sku,
      productName: variant.product.name,
      variantName: variant.name,
      quantity: result.quantity,
      unitPrice: result.originalUnitPrice,
      subtotalAmount: result.originalLineTotal,
      discountAmount: result.discountAmount,
      totalAmount: result.effectiveLineTotal,
      effectiveUnitPrice: result.effectiveUnitPrice,
      appliedPromotion: promo
        ? {
            id: promo.promotionId,
            name: promo.promotionName,
            type: promo.promotionType,
            campaignId: promo.campaignId,
          }
        : null,
      currency,
      calculatedAt,
    };
  }

  /** TODO: replace with a proper shipping rate engine. */
  private calculateBaseShipping(discountedSubtotal: Decimal): Decimal {
    return discountedSubtotal.gte(SHIPPING_RULES.freeShippingThreshold)
      ? ZERO
      : SHIPPING_RULES.flatRate;
  }

  private dedupeSkipped(skipped: SkippedPromotion[]): SkippedPromotion[] {
    const seen = new Map<string, SkippedPromotion>();
    for (const s of skipped) seen.set(`${s.promotionId}:${s.reason}`, s);
    return [...seen.values()];
  }

  private emptyCartResult(currency: string): CartPriceResult {
    return {
      items: [],
      subtotal: ZERO,
      itemDiscountTotal: ZERO,
      discountedSubtotal: ZERO,
      orderDiscounts: [],
      orderDiscountTotal: ZERO,
      shippingAmount: ZERO,
      effectiveShipping: ZERO,
      totalAmount: ZERO,
      currency,
      appliedPromotions: [],
      skippedPromotions: [],
    };
  }
}
