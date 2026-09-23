// src/modules/pricing/promotion-resolver.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PromotionValidator } from './promotion-validator.service';
import { comparePromotions } from './promotion-ranking';
import {
  DiscountLevel,
  PROMOTION_LEVEL_MAP,
  PricingContext,
  ResolvedPromotion,
  SkipReason,
  SkippedPromotion,
  VariantPricingData,
} from './interfaces/pricing.types';

export interface PromotionResolution {
  /** variantId → eligible item-level promotions, best first */
  itemLevel: Map<string, ResolvedPromotion[]>;
  orderLevel: ResolvedPromotion[];
  shippingLevel: ResolvedPromotion[];
  skipped: SkippedPromotion[];
}

/**
 * Finds which promotions apply to a set of variants.
 * Separates "find promotions" from "calculate discounts".
 * Used by: PricingService.
 */
@Injectable()
export class PromotionResolver {
  private readonly logger = new Logger(PromotionResolver.name);
  private readonly CACHE_TTL_MS = 2 * 60 * 1000;

  private cache: { promos: ResolvedPromotion[]; expiresAt: number } | null =
    null;
  private inflight: Promise<ResolvedPromotion[]> | null = null;
  private cacheGeneration = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: PromotionValidator,
  ) {}

  /**
   * The single resolution routine used for product pages, listings and carts.
   * ORDER/SHIPPING promotions apply when they have no targets (cart-wide)
   * or when at least one variant matches their targets.
   */
  async resolve(
    variants: VariantPricingData[],
    context: PricingContext,
  ): Promise<PromotionResolution> {
    const promos = await this.getActivePromotions();

    const itemLevel = new Map<string, ResolvedPromotion[]>();
    const orderLevel: ResolvedPromotion[] = [];
    const shippingLevel: ResolvedPromotion[] = [];
    const skipped: SkippedPromotion[] = [];

    const skip = (promo: ResolvedPromotion, reason: SkipReason) =>
      skipped.push({
        promotionId: promo.id,
        promotionName: promo.name,
        reason,
      });

    for (const cached of promos) {
      const globalSkip = this.validator.validateGlobalEligibility(
        cached,
        context,
      );
      if (globalSkip) {
        skip(cached, globalSkip);
        continue;
      }

      // Copy — never mutate objects that live in the shared cache.
      const promo: ResolvedPromotion = {
        ...cached,
        campaignId: this.validator.resolveCampaignId(cached, context),
        matchSpecificity: 0,
      };
      const level = PROMOTION_LEVEL_MAP[promo.type];

      if (level === DiscountLevel.ITEM) {
        let matched = false;
        for (const variant of variants) {
          if (!this.validator.validateTargetMatch(promo, variant)) continue;
          matched = true;
          const list = itemLevel.get(variant.id) ?? [];
          list.push({
            ...promo,
            matchSpecificity: this.validator.computeMatchSpecificity(
              promo,
              variant,
            ),
          });
          itemLevel.set(variant.id, list);
        }
        if (!matched) skip(promo, SkipReason.NO_MATCHING_TARGETS);
        continue;
      }

      const appliesToCart =
        promo.targets.length === 0 ||
        this.validator.matchesAnyVariant(promo, variants);
      if (!appliesToCart) {
        skip(promo, SkipReason.NO_MATCHING_TARGETS);
        continue;
      }

      if (level === DiscountLevel.SHIPPING) shippingLevel.push(promo);
      else orderLevel.push(promo);
    }

    for (const list of itemLevel.values()) list.sort(comparePromotions);
    orderLevel.sort(comparePromotions);
    shippingLevel.sort(comparePromotions);

    return { itemLevel, orderLevel, shippingLevel, skipped };
  }

  /** Convenience wrapper for a single variant. */
  async resolveForVariant(
    variant: VariantPricingData,
    context: PricingContext,
  ): Promise<{ applicable: ResolvedPromotion[]; skipped: SkippedPromotion[] }> {
    const { itemLevel, skipped } = await this.resolve([variant], context);
    return { applicable: itemLevel.get(variant.id) ?? [], skipped };
  }

  /** Convenience wrapper for cart lines. */
  resolveForCart(
    items: Array<{ variant: VariantPricingData }>,
    context: PricingContext,
  ): Promise<PromotionResolution> {
    return this.resolve(
      items.map((i) => i.variant),
      context,
    );
  }

  /**
   * Invalidate the cache. Call after an admin creates/updates/deletes a
   * promotion, its targets, or a linked campaign.
   * NOTE: this only clears THIS process. See the multi-instance note in the review.
   */
  invalidateCache(): void {
    this.cacheGeneration++;
    this.cache = null;
    this.inflight = null;
    this.logger.log('Promotion cache invalidated');
  }

  // ─── private ──────────────────────────────────────────────────

  /**
   * Cached, with in-flight de-duplication: when the cache expires under load,
   * concurrent requests share ONE DB query instead of each firing their own.
   */
  private getActivePromotions(): Promise<ResolvedPromotion[]> {
    if (this.cache && Date.now() < this.cache.expiresAt) {
      return Promise.resolve(this.cache.promos);
    }

    if (!this.inflight) {
      const generation = this.cacheGeneration;
      const request = this.loadActivePromotions()
        .then((promos) => {
          // Don't store a result that was invalidated while it was loading.
          if (generation === this.cacheGeneration) {
            this.cache = { promos, expiresAt: Date.now() + this.CACHE_TTL_MS };
          }
          return promos;
        })
        .finally(() => {
          if (this.inflight === request) this.inflight = null;
        });
      this.inflight = request;
    }

    return this.inflight;
  }

  private async loadActivePromotions(): Promise<ResolvedPromotion[]> {
    const now = new Date();
    // Look ahead by the TTL so a promotion starting mid-cache isn't delayed up
    // to 2 minutes. The validator still enforces exact start/end per request.
    const horizon = new Date(now.getTime() + this.CACHE_TTL_MS);

    const promos = await this.prisma.promotion.findMany({
      where: {
        isActive: true,
        status: { in: ['ACTIVE', 'SCHEDULED'] },
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: horizon } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      include: {
        targets: true,
        campaigns: {
          select: {
            campaign: {
              select: {
                id: true,
                status: true,
                isActive: true,
                startsAt: true,
                endsAt: true,
                archivedAt: true,
              },
            },
          },
        },
      },
    });

    return promos.map(
      (p): ResolvedPromotion => ({
        id: p.id,
        name: p.name,
        type: p.type,
        status: p.status,
        value: p.value,
        buyQuantity: p.buyQuantity,
        getQuantity: p.getQuantity,
        minOrderAmount: p.minOrderAmount,
        maxDiscountAmount: p.maxDiscountAmount,
        priority: p.priority,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        isActive: p.isActive,
        targets: p.targets.map((t) => ({
          id: t.id,
          targetType: t.targetType,
          productId: t.productId,
          variantId: t.variantId,
          categoryId: t.categoryId,
          brandId: t.brandId,
          tagId: t.tagId,
        })),
        campaigns: p.campaigns.map(({ campaign }) => ({ ...campaign })),
        campaignId: null, // chosen per request by resolve()
        matchSpecificity: 0, // computed per variant by resolve()
      }),
    );
  }
}
