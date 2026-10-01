import { Prisma } from 'src/generated/prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { DiscountCalculator } from './discount-calculator.service';
import { PricingService } from './pricing.service';
import {
  PromotionResolution,
  PromotionResolver,
} from './promotion-resolver.service';
import { PricableItem, VariantPricingData } from './interfaces/pricing.types';
import { makePromotion, makeVariant, money } from './testing/pricing-fixtures';

describe('PricingService', () => {
  // A: priority 10, 10% off, capped at ৳1000 per order. B: priority 0, 20% off.
  const capped = makePromotion({
    id: 'capped',
    priority: 10,
    value: money(10),
    maxDiscountAmount: money(1000),
  });
  const uncapped = makePromotion({ id: 'uncapped', value: money(20) });

  let resolve: jest.Mock;
  let service: PricingService;

  beforeEach(() => {
    resolve = jest.fn(
      (variants: VariantPricingData[]): Promise<PromotionResolution> =>
        Promise.resolve({
          itemLevel: new Map(variants.map((v) => [v.id, [capped, uncapped]])),
          orderLevel: [],
          shippingLevel: [],
          skipped: [],
        }),
    );
    service = new PricingService(
      {} as PrismaService,
      { resolve } as unknown as PromotionResolver,
      new DiscountCalculator(),
    );
  });

  describe('calculateCartPrices', () => {
    const small: PricableItem = {
      variant: makeVariant('small', 9950),
      quantity: 1,
    };
    const large: PricableItem = {
      variant: makeVariant('large', 15000),
      quantity: 1,
    };

    it('gives the same discount whatever order the cart lines arrive in', async () => {
      const forward = await service.calculateCartPrices([small, large]);
      const reversed = await service.calculateCartPrices([large, small]);

      // large: capped wants 1500 but is capped to 1000 → uncapped 20% (3000) wins.
      // small: capped gives 995 in full and outranks uncapped.
      expect(forward.itemDiscountTotal).toEqual(money(3995));
      expect(reversed.itemDiscountTotal).toEqual(money(3995));
    });

    it('returns lines in the order they were given', async () => {
      const result = await service.calculateCartPrices([small, large]);
      expect(result.items.map((i) => i.variantId)).toEqual(['small', 'large']);
    });

    it('reads promotions from the resolver cache', async () => {
      await service.calculateCartPrices([small]);
      expect(resolve).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { db: undefined },
      );
    });
  });

  describe('createOrderPricing', () => {
    it('reads promotions fresh through the order transaction', async () => {
      const row = { ...makeVariant('v1', 1000), optionValues: [] };
      const tx = {
        productVariant: { findMany: jest.fn().mockResolvedValue([row]) },
      } as unknown as Prisma.TransactionClient;

      await service.createOrderPricing(
        [{ variantId: 'v1', quantity: 1 }],
        {},
        tx,
      );

      expect(resolve).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { db: tx },
      );
    });
  });
});
