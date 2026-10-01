import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma/client';
import { PromotionResolver } from './promotion-resolver.service';
import { PromotionValidator } from './promotion-validator.service';
import { makeVariant, money } from './testing/pricing-fixtures';

/** A promotions row as returned by the resolver's findMany. */
const promotionRow = (id: string) => ({
  id,
  name: id,
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
});

const dbReturning = (...rows: ReturnType<typeof promotionRow>[]) => ({
  promotion: { findMany: jest.fn().mockResolvedValue(rows) },
});

describe('PromotionResolver', () => {
  const variant = makeVariant('v1', 1000);
  const appliedIds = async (resolver: PromotionResolver, options = {}) => {
    const { itemLevel } = await resolver.resolve([variant], {}, options);
    return (itemLevel.get('v1') ?? []).map((p) => p.id);
  };

  let prisma: ReturnType<typeof dbReturning>;
  let resolver: PromotionResolver;

  beforeEach(() => {
    prisma = dbReturning(promotionRow('sale'));
    resolver = new PromotionResolver(
      prisma as unknown as PrismaService,
      new PromotionValidator(),
    );
  });

  it('serves repeat lookups from the cache', async () => {
    await appliedIds(resolver);
    await appliedIds(resolver);
    expect(prisma.promotion.findMany).toHaveBeenCalledTimes(1);
  });

  it('stops applying a disabled promotion as soon as the cache is invalidated', async () => {
    expect(await appliedIds(resolver)).toEqual(['sale']);

    // Admin disables the promotion → it no longer comes back from the DB.
    prisma.promotion.findMany.mockResolvedValue([]);
    resolver.invalidateCache();

    expect(await appliedIds(resolver)).toEqual([]);
  });

  it('reads fresh through the given client, bypassing a stale cache', async () => {
    await appliedIds(resolver); // cache now holds "sale"

    // Inside the order transaction the promotion is already gone.
    const tx = dbReturning();
    const applied = await appliedIds(resolver, {
      db: tx as unknown as Prisma.TransactionClient,
    });

    expect(applied).toEqual([]);
    expect(tx.promotion.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.promotion.findMany).toHaveBeenCalledTimes(1);
  });
});
