// src/modules/pricing/promotion-validator.service.ts

import { Injectable } from '@nestjs/common';
import { CampaignStatus, PromotionStatus } from 'src/generated/prisma/enums';
import {
  CAMPAIGN_SPECIFICITY_BONUS,
  PricingContext,
  ResolvedCampaign,
  ResolvedPromotion,
  ResolvedTarget,
  SkipReason,
  TARGET_SPECIFICITY,
  VariantPricingData,
} from './interfaces/pricing.types';

/**
 * Decides whether a promotion is eligible. Pure — no DB, no side effects.
 * Used by: PromotionResolver.
 */
@Injectable()
export class PromotionValidator {
  /**
   * Checks that don't depend on a specific variant.
   * Returns null if eligible, otherwise the reason it was skipped.
   */
  validateGlobalEligibility(
    promo: ResolvedPromotion,
    context: PricingContext,
  ): SkipReason | null {
    const now = context.timestamp ?? new Date();

    if (!promo.isActive || !this.hasLiveStatus(promo.status, promo.startsAt)) {
      return SkipReason.NOT_ACTIVE;
    }

    if (!this.isWithinWindow(now, promo.startsAt, promo.endsAt)) {
      return SkipReason.OUTSIDE_DATE_RANGE;
    }

    // A campaign-linked promotion only runs while one of its campaigns is live.
    if (
      promo.campaigns.length > 0 &&
      this.liveCampaigns(promo, now).length === 0
    ) {
      return SkipReason.CAMPAIGN_NOT_LIVE;
    }

    // Without cart context (product pages) we can't know the basket size,
    // so we don't advertise a price the customer might not get.
    if (
      promo.minOrderAmount &&
      (!context.cartSubtotal || context.cartSubtotal.lt(promo.minOrderAmount))
    ) {
      return SkipReason.MIN_ORDER_NOT_MET;
    }

    return null;
  }

  /**
   * The campaign a promotion is attributed to for this request:
   * the one being browsed if it's live, otherwise the first live one.
   */
  resolveCampaignId(promo: ResolvedPromotion, context: PricingContext): string | null {
    const live = this.liveCampaigns(promo, context.timestamp ?? new Date());
    if (live.length === 0) return null;
    return live.find((c) => c.id === context.activeCampaignId)?.id ?? live[0].id;
  }

  /** True if at least one target matches the variant. */
  validateTargetMatch(promo: ResolvedPromotion, variant: VariantPricingData): boolean {
    return promo.targets.some((target) => this.targetMatches(target, variant));
  }

  /** True if at least one target matches any of the variants. */
  matchesAnyVariant(promo: ResolvedPromotion, variants: VariantPricingData[]): boolean {
    return variants.some((variant) => this.validateTargetMatch(promo, variant));
  }

  /**
   * Specificity of the BEST matching target, plus a campaign bonus.
   * Non-matching targets contribute nothing.
   */
  computeMatchSpecificity(promo: ResolvedPromotion, variant: VariantPricingData): number {
    let best = 0;
    for (const target of promo.targets) {
      if (this.targetMatches(target, variant)) {
        best = Math.max(best, TARGET_SPECIFICITY[target.targetType]);
      }
    }
    if (best > 0 && promo.campaignId) best += CAMPAIGN_SPECIFICITY_BONUS;
    return best;
  }

  /** Global checks + target match. */
  validateForVariant(
    promo: ResolvedPromotion,
    variant: VariantPricingData,
    context: PricingContext,
  ): SkipReason | null {
    const globalSkip = this.validateGlobalEligibility(promo, context);
    if (globalSkip) return globalSkip;
    return this.validateTargetMatch(promo, variant) ? null : SkipReason.NO_MATCHING_TARGETS;
  }

  // ─── private ──────────────────────────────────────────────────

  /** The single place that decides whether one target matches one variant. */
  private targetMatches(target: ResolvedTarget, variant: VariantPricingData): boolean {
    switch (target.targetType) {
      case 'ALL_PRODUCTS':
        return true;
      case 'VARIANT':
        return target.variantId === variant.id;
      case 'PRODUCT':
        return target.productId === variant.productId;
      case 'CATEGORY':
        return variant.product.categories.some((c) => c.categoryId === target.categoryId);
      case 'BRAND':
        return target.brandId !== null && variant.product.brandId === target.brandId;
      case 'TAG':
        return variant.product.tags.some((t) => t.tagId === target.tagId);
      default:
        return false;
    }
  }

  /**
   * ACTIVE is live. SCHEDULED becomes live once its start date passes,
   * so promotions/campaigns go live on time without a cron flipping status.
   */
  private hasLiveStatus(
    status: PromotionStatus | CampaignStatus,
    startsAt: Date | null,
  ): boolean {
    if (status === 'ACTIVE') return true;
    if (status === 'SCHEDULED') return startsAt !== null;
    return false;
  }

  private isWithinWindow(now: Date, startsAt: Date | null, endsAt: Date | null): boolean {
    if (startsAt && now < startsAt) return false;
    if (endsAt && now > endsAt) return false;
    return true;
  }

  private liveCampaigns(promo: ResolvedPromotion, now: Date): ResolvedCampaign[] {
    return promo.campaigns.filter(
      (c) =>
        c.isActive &&
        c.archivedAt === null &&
        this.hasLiveStatus(c.status, c.startsAt) &&
        this.isWithinWindow(now, c.startsAt, c.endsAt),
    );
  }
}
