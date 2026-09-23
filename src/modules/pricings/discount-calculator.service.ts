// src/modules/pricing/discount-calculator.service.ts

import { Injectable } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { compareRank } from './promotion-ranking';
import {
  ZERO,
  formatMoney,
  round2,
} from '../../../src/common/utils/money.util';
import {
  AppliedDiscount,
  DiscountLevel,
  ItemPriceResult,
  PROMOTION_LEVEL_MAP,
  ResolvedPromotion,
  SkipReason,
  SkippedPromotion,
  VariantPricingData,
} from './interfaces/pricing.types';

/**
 * promotionId → discount already granted in the current calculation.
 * Makes maxDiscountAmount a cap per ORDER, not per line.
 */
export type DiscountCapLedger = Map<string, Decimal>;

export interface DiscountDecision {
  discount: AppliedDiscount | null;
  skipped: SkippedPromotion[];
}

interface Candidate {
  promo: ResolvedPromotion;
  amount: Decimal;
}

/**
 * Pure calculation engine. No database access.
 *
 * Rules:
 *   - ONE item-level discount per line: highest rank wins
 *     (priority → specificity → campaign). Equal rank → bigger saving wins.
 *   - ONE shipping discount, same selection rule.
 *   - maxDiscountAmount is a per-order cap, tracked with a DiscountCapLedger.
 *   - A discount never exceeds the line total / shipping amount.
 *   - All discount amounts are rounded to 2dp (half-up).
 */
@Injectable()
export class DiscountCalculator {
  calculateBestItemDiscount(
    variant: VariantPricingData,
    quantity: number,
    promos: ResolvedPromotion[],
    ledger: DiscountCapLedger = new Map(),
  ): DiscountDecision {
    const lineTotal = round2(variant.price.mul(quantity));

    const { winner, skipped } = this.selectBest(
      promos,
      (promo) =>
        PROMOTION_LEVEL_MAP[promo.type] === DiscountLevel.ITEM
          ? Decimal.min(this.computeItemDiscount(promo, variant.price, quantity), lineTotal)
          : null,
      ledger,
    );

    return {
      discount: winner ? this.toAppliedDiscount(winner, variant.id) : null,
      skipped,
    };
  }

  calculateBestShippingDiscount(
    shippingAmount: Decimal,
    promos: ResolvedPromotion[],
    ledger: DiscountCapLedger = new Map(),
  ): DiscountDecision {
    if (shippingAmount.lte(0)) return { discount: null, skipped: [] };

    const { winner, skipped } = this.selectBest(
      promos,
      (promo) => this.computeShippingDiscount(promo, shippingAmount),
      ledger,
    );

    return {
      discount: winner ? this.toAppliedDiscount(winner, null) : null,
      skipped,
    };
  }

  /** Record an applied discount against its promotion's order-wide cap. */
  recordCapUsage(ledger: DiscountCapLedger, discount: AppliedDiscount | null): void {
    if (!discount) return;
    const used = ledger.get(discount.promotionId) ?? ZERO;
    ledger.set(discount.promotionId, used.plus(discount.discountAmount));
  }

  /** Build a complete ItemPriceResult. Line total is the source of truth. */
  buildItemPriceResult(
    variant: VariantPricingData,
    quantity: number,
    discount: AppliedDiscount | null,
  ): ItemPriceResult {
    const originalUnitPrice = variant.price;
    const originalLineTotal = round2(originalUnitPrice.mul(quantity));
    const discountAmount = discount
      ? Decimal.min(round2(discount.discountAmount), originalLineTotal)
      : ZERO;
    const effectiveLineTotal = originalLineTotal.minus(discountAmount);
    const effectiveUnitPrice =
      quantity > 0 ? round2(effectiveLineTotal.div(quantity)) : originalUnitPrice;

    return {
      variantId: variant.id,
      sku: variant.sku,
      quantity,
      originalUnitPrice,
      originalLineTotal,
      appliedDiscount: discount,
      discountAmount,
      effectiveUnitPrice,
      effectiveLineTotal,
      priceLabel: discount
        ? `${formatMoney(effectiveUnitPrice)} (was ${formatMoney(originalUnitPrice)})`
        : formatMoney(originalUnitPrice),
      hasPromotion: discount !== null,
    };
  }

  // ─── selection ────────────────────────────────────────────────

  /**
   * Walks promotions in rank order (already sorted by the resolver).
   * `computeAmount` returns null when a promotion doesn't belong to this level.
   */
  private selectBest(
    promos: ResolvedPromotion[],
    computeAmount: (promo: ResolvedPromotion) => Decimal | null,
    ledger: DiscountCapLedger,
  ): { winner: Candidate | null; skipped: SkippedPromotion[] } {
    const skipped: SkippedPromotion[] = [];
    let winner: Candidate | null = null;

    for (const promo of promos) {
      const raw = computeAmount(promo);
      if (raw === null) continue;

      const { amount, capExhausted } = this.applyCap(promo, raw, ledger);
      if (amount.lte(0)) {
        skipped.push(
          this.skip(
            promo,
            capExhausted ? SkipReason.MAX_DISCOUNT_REACHED : SkipReason.ZERO_DISCOUNT,
          ),
        );
        continue;
      }

      if (!winner) {
        winner = { promo, amount };
      } else if (compareRank(promo, winner.promo) === 0 && amount.gt(winner.amount)) {
        skipped.push(this.skip(winner.promo, SkipReason.OUTPRIORITIZED));
        winner = { promo, amount };
      } else {
        skipped.push(this.skip(promo, SkipReason.OUTPRIORITIZED));
      }
    }

    return { winner, skipped };
  }

  private applyCap(
    promo: ResolvedPromotion,
    rawAmount: Decimal,
    ledger: DiscountCapLedger,
  ): { amount: Decimal; capExhausted: boolean } {
    const amount = round2(Decimal.max(rawAmount, ZERO));
    if (!promo.maxDiscountAmount) return { amount, capExhausted: false };

    const used = ledger.get(promo.id) ?? ZERO;
    const remaining = Decimal.max(promo.maxDiscountAmount.minus(used), ZERO);
    return { amount: Decimal.min(amount, remaining), capExhausted: remaining.lte(0) };
  }

  // ─── math (pure) ──────────────────────────────────────────────

  private computeItemDiscount(
    promo: ResolvedPromotion,
    unitPrice: Decimal,
    quantity: number,
  ): Decimal {
    const { value } = promo;

    switch (promo.type) {
      case 'PERCENTAGE': {
        if (value === null || value.lte(0)) return ZERO;
        const percent = Decimal.min(value, 100);
        return unitPrice.mul(quantity).mul(percent).div(100);
      }

      case 'FIXED_AMOUNT': {
        if (value === null || value.lte(0)) return ZERO;
        // PER UNIT, so the product page (qty 1) and the cart (qty n) agree.
        return Decimal.min(value, unitPrice).mul(quantity);
      }

      case 'FIXED_PRICE': {
        if (value === null || value.lt(0)) return ZERO;
        const savingPerUnit = unitPrice.minus(value);
        return savingPerUnit.gt(0) ? savingPerUnit.mul(quantity) : ZERO;
      }

      case 'BUY_X_GET_Y':
        return this.computeBuyXGetY(promo, unitPrice, quantity);

      default:
        return ZERO;
    }
  }

  private computeShippingDiscount(
    promo: ResolvedPromotion,
    shippingAmount: Decimal,
  ): Decimal | null {
    switch (promo.type) {
      case 'FREE_SHIPPING':
        return shippingAmount;
      case 'SHIPPING_DISCOUNT':
        return promo.value && promo.value.gt(0)
          ? Decimal.min(promo.value, shippingAmount)
          : ZERO;
      default:
        return null;
    }
  }

  /**
   * Buy X Get Y (same variant). Buy 2 Get 1, qty 6 → 2 sets → 2 free.
   */
  private computeBuyXGetY(
    promo: ResolvedPromotion,
    unitPrice: Decimal,
    quantity: number,
  ): Decimal {
    const buyQty = promo.buyQuantity ?? 0;
    const getQty = promo.getQuantity ?? 0;
    if (buyQty <= 0 || getQty <= 0) return ZERO;

    const completeSets = Math.floor(quantity / (buyQty + getQty));
    return unitPrice.mul(completeSets * getQty);
  }

  // ─── output helpers ───────────────────────────────────────────

  private toAppliedDiscount(winner: Candidate, variantId: string | null): AppliedDiscount {
    const { promo, amount } = winner;
    return {
      promotionId: promo.id,
      promotionName: promo.name,
      promotionType: promo.type,
      targetDescription: this.describe(promo),
      discountAmount: amount,
      isOrderLevel: PROMOTION_LEVEL_MAP[promo.type] !== DiscountLevel.ITEM,
      variantId,
      campaignId: promo.campaignId,
    };
  }

  private skip(promo: ResolvedPromotion, reason: SkipReason): SkippedPromotion {
    return { promotionId: promo.id, promotionName: promo.name, reason };
  }

  private describe(promo: ResolvedPromotion): string {
    const value = promo.value ?? ZERO;
    switch (promo.type) {
      case 'PERCENTAGE':
        return `${value.toString()}% off`;
      case 'FIXED_AMOUNT':
        return `${formatMoney(value)} off`;
      case 'FIXED_PRICE':
        return `Now ${formatMoney(value)}`;
      case 'BUY_X_GET_Y':
        return `Buy ${promo.buyQuantity} Get ${promo.getQuantity} Free`;
      case 'FREE_SHIPPING':
        return 'Free shipping';
      case 'SHIPPING_DISCOUNT':
        return `${formatMoney(value)} off shipping`;
      default:
        return promo.name;
    }
  }
}
