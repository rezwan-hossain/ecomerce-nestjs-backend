import {
  DiscountCalculator,
  DiscountCapLedger,
} from './discount-calculator.service';
import { SkipReason } from './interfaces/pricing.types';
import { makePromotion, makeVariant, money } from './testing/pricing-fixtures';

describe('DiscountCalculator', () => {
  const calculator = new DiscountCalculator();

  const discountFor = (
    price: number,
    quantity: number,
    promos = [makePromotion()],
    ledger?: DiscountCapLedger,
  ) =>
    calculator.calculateBestItemDiscount(
      makeVariant('v1', price),
      quantity,
      promos,
      ledger,
    );

  describe('item discount math', () => {
    it('applies a percentage to the whole line', () => {
      const { discount } = discountFor(1000, 2, [
        makePromotion({ value: money(20) }),
      ]);
      expect(discount?.discountAmount).toEqual(money(400));
    });

    it('rounds half-up to 2 decimal places', () => {
      // 12.5% of 0.99 = 0.12375 → 0.12
      // 12.5% of 1.00 = 0.125   → 0.13
      const promo = makePromotion({ value: money(12.5) });
      expect(discountFor(0.99, 1, [promo]).discount?.discountAmount).toEqual(
        money('0.12'),
      );
      expect(discountFor(1, 1, [promo]).discount?.discountAmount).toEqual(
        money('0.13'),
      );
    });

    it('applies a fixed amount per unit, never more than the unit price', () => {
      const perUnit = makePromotion({
        type: 'FIXED_AMOUNT',
        value: money(150),
      });
      expect(discountFor(1000, 3, [perUnit]).discount?.discountAmount).toEqual(
        money(450),
      );

      const tooBig = makePromotion({
        type: 'FIXED_AMOUNT',
        value: money(5000),
      });
      expect(discountFor(1000, 2, [tooBig]).discount?.discountAmount).toEqual(
        money(2000),
      );
    });

    it('applies a fixed price as the saving per unit', () => {
      const promo = makePromotion({ type: 'FIXED_PRICE', value: money(800) });
      expect(discountFor(1000, 2, [promo]).discount?.discountAmount).toEqual(
        money(400),
      );
    });

    it('skips a fixed price that is above the current price', () => {
      const promo = makePromotion({ type: 'FIXED_PRICE', value: money(1200) });
      const { discount, skipped } = discountFor(1000, 1, [promo]);
      expect(discount).toBeNull();
      expect(skipped).toEqual([
        expect.objectContaining({ reason: SkipReason.ZERO_DISCOUNT }),
      ]);
    });

    it('gives Y free per complete set for buy X get Y', () => {
      const promo = makePromotion({
        type: 'BUY_X_GET_Y',
        value: null,
        buyQuantity: 2,
        getQuantity: 1,
      });
      expect(discountFor(100, 6, [promo]).discount?.discountAmount).toEqual(
        money(200),
      );
      expect(discountFor(100, 5, [promo]).discount?.discountAmount).toEqual(
        money(100),
      );
      expect(discountFor(100, 2, [promo]).discount).toBeNull();
    });
  });

  describe('choosing between promotions', () => {
    it('lets the higher-ranked promotion win even when it saves less', () => {
      const ranked = makePromotion({
        id: 'ranked',
        priority: 10,
        value: money(5),
      });
      const bigger = makePromotion({
        id: 'bigger',
        priority: 0,
        value: money(50),
      });

      const { discount, skipped } = discountFor(1000, 1, [ranked, bigger]);

      expect(discount?.promotionId).toBe('ranked');
      expect(skipped).toEqual([
        expect.objectContaining({
          promotionId: 'bigger',
          reason: SkipReason.OUTPRIORITIZED,
        }),
      ]);
    });

    it('picks the bigger saving when ranks are equal', () => {
      const small = makePromotion({ id: 'small', value: money(5) });
      const big = makePromotion({ id: 'big', value: money(15) });
      expect(discountFor(1000, 1, [small, big]).discount?.promotionId).toBe(
        'big',
      );
    });
  });

  describe('maxDiscountAmount caps', () => {
    const capped = makePromotion({
      id: 'capped',
      priority: 10,
      value: money(10),
      maxDiscountAmount: money(1000),
    });
    const uncapped = makePromotion({
      id: 'uncapped',
      priority: 0,
      value: money(20),
    });
    const ledgerWithUsed = (used: number): DiscountCapLedger =>
      new Map([['capped', money(used)]]);

    it('does not let a nearly spent cap block a bigger lower-ranked discount', () => {
      // capped: 10% of 15000 = 1500, but only ৳5 of its cap is left.
      // uncapped: 20% of 15000 = 3000.
      const { discount, skipped } = discountFor(
        15000,
        1,
        [capped, uncapped],
        ledgerWithUsed(995),
      );

      expect(discount?.promotionId).toBe('uncapped');
      expect(discount?.discountAmount).toEqual(money(3000));
      expect(skipped).toEqual([
        expect.objectContaining({
          promotionId: 'capped',
          reason: SkipReason.MAX_DISCOUNT_REACHED,
        }),
      ]);
    });

    it('still applies a capped promotion when it saves more than the alternative', () => {
      // capped: ৳900 left (1500 wanted). uncapped at 5%: 750.
      const fivePercent = makePromotion({ id: 'uncapped', value: money(5) });
      const { discount } = discountFor(
        15000,
        1,
        [capped, fivePercent],
        ledgerWithUsed(100),
      );

      expect(discount?.promotionId).toBe('capped');
      expect(discount?.discountAmount).toEqual(money(900));
    });

    it('never lets a capped promotion beat a higher-ranked one', () => {
      const ranked = makePromotion({
        id: 'ranked',
        priority: 10,
        value: money(10),
      });
      const lowerCapped = makePromotion({
        id: 'lower-capped',
        priority: 0,
        value: money(50),
        maxDiscountAmount: money(2000),
      });
      // ranked: 1500. lower-capped: 7500 capped to 2000 — bigger, but ranked lower.
      const { discount } = discountFor(15000, 1, [ranked, lowerCapped]);
      expect(discount?.promotionId).toBe('ranked');
    });

    it('falls back to the next promotion once a cap is used up', () => {
      const { discount, skipped } = discountFor(
        15000,
        1,
        [capped, uncapped],
        ledgerWithUsed(1000),
      );

      expect(discount?.promotionId).toBe('uncapped');
      expect(skipped).toEqual([
        expect.objectContaining({
          promotionId: 'capped',
          reason: SkipReason.MAX_DISCOUNT_REACHED,
        }),
      ]);
    });

    it('shares one cap across every line of the order', () => {
      const ledger: DiscountCapLedger = new Map();
      const total = ['a', 'b', 'c'].reduce((sum, id) => {
        const { discount } = calculator.calculateBestItemDiscount(
          makeVariant(id, 5000),
          1,
          [capped],
          ledger,
        );
        calculator.recordCapUsage(ledger, discount);
        return sum.plus(discount?.discountAmount ?? 0);
      }, money(0));

      expect(total).toEqual(money(1000));
    });
  });

  describe('shipping discounts', () => {
    it('removes all shipping for FREE_SHIPPING', () => {
      const promo = makePromotion({ type: 'FREE_SHIPPING', value: null });
      const { discount } = calculator.calculateBestShippingDiscount(
        money(120),
        [promo],
      );
      expect(discount?.discountAmount).toEqual(money(120));
    });

    it('never discounts more than the shipping amount', () => {
      const promo = makePromotion({
        type: 'SHIPPING_DISCOUNT',
        value: money(200),
      });
      const { discount } = calculator.calculateBestShippingDiscount(
        money(120),
        [promo],
      );
      expect(discount?.discountAmount).toEqual(money(120));
    });

    it('ignores item-level promotions', () => {
      const { discount } = calculator.calculateBestShippingDiscount(
        money(120),
        [makePromotion()],
      );
      expect(discount).toBeNull();
    });
  });
});
