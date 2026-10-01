/**
 * Development seed: catalog, users, reviews, campaigns and promotions.
 *
 *   npx prisma db seed
 *
 * Idempotent — every row is looked up by its natural key (slug, name, email,
 * SKU) first and only created when missing, so re-running is a no-op and rows
 * you already have (e.g. the "Nike" brand) are reused, never modified.
 *
 * Product data and images come from DummyJSON (https://dummyjson.com),
 * snapshotted in products.json; images are served from cdn.dummyjson.com.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../src/generated/prisma/client';
import type {
  PromotionTargetType,
  PromotionType,
  PromotionScope,
  PromotionStatus,
} from '../../src/generated/prisma/enums';
import { createSlug } from '../../src/common/utils/slug.util';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

// ─── Fixture ──────────────────────────────────────────────────

interface FixtureProduct {
  title: string;
  description: string;
  brand: string | null;
  priceUsd: number;
  stock: number;
  tags: string[];
  images: string[];
  reviews: {
    rating: number;
    comment: string;
    reviewerName: string;
    reviewerEmail: string;
  }[];
}

const fixture: Record<string, FixtureProduct[]> = JSON.parse(
  readFileSync(join(__dirname, 'products.json'), 'utf8'),
);

// ─── Config ───────────────────────────────────────────────────

const USD_TO_BDT = 120;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/** Picsum returns a stable photo per seed string. */
const photo = (seed: string, w: number, h: number) =>
  `https://picsum.photos/seed/${seed}/${w}/${h}`;
const logo = (name: string) =>
  `https://placehold.co/200x200/png?text=${encodeURIComponent(name)}`;

/** Root categories → leaf categories; `source` is the fixture key. */
const CATEGORY_TREE = [
  {
    name: 'Fashion',
    slug: 'fashion',
    children: [
      { name: "Men's Shoes", slug: 'mens-shoes', source: 'mens-shoes' },
      { name: "Women's Shoes", slug: 'womens-shoes', source: 'womens-shoes' },
      { name: "Men's Shirts", slug: 'mens-shirts', source: 'mens-shirts' },
      { name: "Women's Dresses", slug: 'womens-dresses', source: 'tops' },
    ],
  },
  {
    name: 'Electronics',
    slug: 'electronics',
    children: [
      { name: 'Smartphones', slug: 'smartphones', source: 'smartphones' },
      { name: 'Laptops', slug: 'laptops', source: 'laptops' },
    ],
  },
  {
    name: 'Accessories',
    slug: 'accessories',
    children: [
      { name: 'Watches', slug: 'watches', source: 'mens-watches' },
      { name: "Women's Bags", slug: 'womens-bags', source: 'womens-bags' },
      { name: 'Sunglasses', slug: 'sunglasses', source: 'sunglasses' },
    ],
  },
];

const OPTIONS = [
  {
    name: 'Shoe Size',
    displayName: 'Size (EU)',
    values: ['36', '37', '38', '39', '40', '41', '42', '43', '44'],
  },
  {
    name: 'Shirt Size',
    displayName: 'Size',
    values: ['S', 'M', 'L', 'XL', '2XL'],
  },
  { name: 'Dress Size', displayName: 'Size', values: ['XS', 'S', 'M', 'L'] },
  {
    name: 'Storage',
    displayName: 'Storage',
    values: ['64GB', '128GB', '256GB', '512GB'],
  },
  { name: 'RAM', displayName: 'Memory', values: ['8GB', '16GB', '32GB'] },
];

/**
 * How each fixture category is split into variants. `priceStep` raises the
 * price per step (e.g. 256GB costs 12% more than 128GB). Categories not listed
 * get a single variant with no options.
 */
const VARIANTS_BY_SOURCE: Record<
  string,
  { option: string; values: string[]; priceStep?: number }
> = {
  'mens-shoes': { option: 'Shoe Size', values: ['40', '41', '42', '43', '44'] },
  'womens-shoes': {
    option: 'Shoe Size',
    values: ['36', '37', '38', '39', '40'],
  },
  'mens-shirts': { option: 'Shirt Size', values: ['S', 'M', 'L', 'XL'] },
  tops: { option: 'Dress Size', values: ['XS', 'S', 'M', 'L'] },
  smartphones: {
    option: 'Storage',
    values: ['128GB', '256GB'],
    priceStep: 0.12,
  },
  laptops: { option: 'RAM', values: ['16GB', '32GB'], priceStep: 0.15 },
};

const TEMPLATES = [
  {
    name: 'Shoe Sizes (EU)',
    option: 'Shoe Size',
    values: ['39', '40', '41', '42', '43', '44'],
  },
  {
    name: 'Apparel Sizes',
    option: 'Shirt Size',
    values: ['S', 'M', 'L', 'XL', '2XL'],
  },
  {
    name: 'Phone Storage',
    option: 'Storage',
    values: ['64GB', '128GB', '256GB', '512GB'],
  },
];

// ─── Helpers ──────────────────────────────────────────────────

/** Rounds to the nearest ৳10. */
const toBdt = (usd: number) => Math.round((usd * USD_TO_BDT) / 10) * 10;

/** Must match buildOptionKey() in products.service.ts. */
const buildOptionKey = (ids: string[]) =>
  ids.length ? [...ids].sort().join(':') : null;

const skuFor = (slug: string, value?: string) =>
  (value ? `${slug}-${value}` : slug).toUpperCase().slice(0, 64);

const log = (label: string, created: number, total: number) =>
  console.log(
    `  ${label.padEnd(18)} ${created} created, ${total - created} existing`,
  );

// ─── Seeders ──────────────────────────────────────────────────

async function seedCategories() {
  const bySource = new Map<string, { id: string; parentId: string }>();
  const bySlug = new Map<string, string>();
  let created = 0;
  let total = 0;

  const ensure = async (
    name: string,
    slug: string,
    parentId: string | null,
  ) => {
    total++;
    const existing = await prisma.category.findFirst({
      where: { OR: [{ slug }, { name, parentId }] },
    });
    if (existing) return existing.id;
    created++;
    const row = await prisma.category.create({
      data: { name, slug, parentId, position: total },
    });
    return row.id;
  };

  for (const root of CATEGORY_TREE) {
    const rootId = await ensure(root.name, root.slug, null);
    bySlug.set(root.slug, rootId);
    for (const child of root.children) {
      const id = await ensure(child.name, child.slug, rootId);
      bySlug.set(child.slug, id);
      bySource.set(child.source, { id, parentId: rootId });
    }
  }

  log('categories', created, total);
  return { bySource, bySlug };
}

async function seedBrands() {
  const names = new Set<string>();
  for (const products of Object.values(fixture))
    for (const p of products) if (p.brand) names.add(p.brand);

  const ids = new Map<string, string>();
  let created = 0;
  for (const name of names) {
    const slug = createSlug(name);
    const existing = await prisma.brand.findFirst({
      where: {
        OR: [{ slug }, { name: { equals: name, mode: 'insensitive' } }],
      },
    });
    if (existing) {
      ids.set(name, existing.id);
      continue;
    }
    created++;
    const row = await prisma.brand.create({
      data: { name, slug, logoUrl: logo(name) },
    });
    ids.set(name, row.id);
  }

  log('brands', created, names.size);
  return ids;
}

async function seedTags() {
  const names = new Set<string>();
  for (const products of Object.values(fixture))
    for (const p of products) p.tags.forEach((t) => names.add(t));

  const ids = new Map<string, string>();
  let created = 0;
  for (const name of names) {
    const slug = createSlug(name);
    const existing = await prisma.tag.findFirst({
      where: {
        OR: [{ slug }, { name: { equals: name, mode: 'insensitive' } }],
      },
    });
    if (existing) {
      ids.set(name, existing.id);
      continue;
    }
    created++;
    const row = await prisma.tag.create({ data: { name, slug } });
    ids.set(name, row.id);
  }

  log('tags', created, names.size);
  return ids;
}

/** Returns optionName → { id, values: valueName → optionValueId }. */
async function seedOptions() {
  const result = new Map<string, { id: string; values: Map<string, string> }>();
  let created = 0;

  for (const opt of OPTIONS) {
    let option = await prisma.option.findUnique({ where: { name: opt.name } });
    if (!option) {
      created++;
      option = await prisma.option.create({
        data: { name: opt.name, displayName: opt.displayName },
      });
    }
    await prisma.optionValue.createMany({
      data: opt.values.map((value) => ({ optionId: option.id, value })),
      skipDuplicates: true,
    });
    const values = await prisma.optionValue.findMany({
      where: { optionId: option.id },
    });
    result.set(option.name, {
      id: option.id,
      values: new Map(values.map((v) => [v.value, v.id])),
    });
  }

  log('options', created, OPTIONS.length);
  return result;
}

async function seedTemplates(options: Awaited<ReturnType<typeof seedOptions>>) {
  let created = 0;
  for (const t of TEMPLATES) {
    if (await prisma.variantTemplate.findUnique({ where: { name: t.name } }))
      continue;
    const option = options.get(t.option)!;
    created++;
    await prisma.variantTemplate.create({
      data: {
        name: t.name,
        options: {
          create: {
            optionId: option.id,
            values: {
              create: t.values.map((v) => ({
                optionValueId: option.values.get(v)!,
              })),
            },
          },
        },
      },
    });
  }
  log('variant templates', created, TEMPLATES.length);
}

async function seedUsers() {
  const users = new Map<
    string,
    { email: string; firstName: string; lastName: string }
  >();
  users.set('admin@shop.test', {
    email: 'admin@shop.test',
    firstName: 'Shop',
    lastName: 'Admin',
  });
  for (const products of Object.values(fixture))
    for (const p of products)
      for (const r of p.reviews) {
        const [firstName, ...rest] = r.reviewerName.split(' ');
        users.set(r.reviewerEmail, {
          email: r.reviewerEmail,
          firstName,
          lastName: rest.join(' '),
        });
      }

  const { count } = await prisma.user.createMany({
    data: [...users.values()].map((u, i) => ({
      ...u,
      userName: u.email.split('@')[0],
      role: u.email === 'admin@shop.test' ? 'SUPER_ADMIN' : 'CUSTOMER',
      image: `https://i.pravatar.cc/150?u=${encodeURIComponent(u.email)}`,
      gender: i % 2 ? 'female' : 'male',
    })),
    skipDuplicates: true,
  });
  log('users', count, users.size);

  const rows = await prisma.user.findMany({
    where: { email: { in: [...users.keys()] } },
    select: { id: true, email: true },
  });
  return new Map(rows.map((u) => [u.email, u.id]));
}

async function seedProducts(deps: {
  categories: Awaited<ReturnType<typeof seedCategories>>;
  brands: Map<string, string>;
  tags: Map<string, string>;
  options: Awaited<ReturnType<typeof seedOptions>>;
  users: Map<string, string>;
}) {
  let created = 0;
  let total = 0;
  let reviews = 0;
  // Some fixture titles slugify identically ("Off White & Red" vs "Off White
  // Red"). Suffix by fixture order, not DB state, so re-runs pick the same slug.
  const usedSlugs = new Set<string>();

  for (const [source, products] of Object.entries(fixture)) {
    const category = deps.categories.bySource.get(source)!;
    const variantSpec = VARIANTS_BY_SOURCE[source];
    const option = variantSpec ? deps.options.get(variantSpec.option)! : null;

    for (const [index, p] of products.entries()) {
      total++;
      let slug = createSlug(p.title);
      for (let n = 2; usedSlugs.has(slug); n++)
        slug = `${createSlug(p.title)}-${n}`;
      usedSlugs.add(slug);
      if (await prisma.product.findUnique({ where: { slug } })) continue;
      created++;

      const basePrice = toBdt(p.priceUsd);
      const values = variantSpec?.values ?? [undefined];
      const stockEach = Math.max(1, Math.floor(p.stock / values.length));

      const variants = values.map((value, i) => {
        const optionValueIds = value ? [option!.values.get(value)!] : [];
        const price = Math.round(
          basePrice * (1 + (variantSpec?.priceStep ?? 0) * i),
        );
        // Every 4th product has its last variant sold out, to exercise stock UI.
        const soldOut = index % 4 === 3 && i === values.length - 1;
        return {
          sku: skuFor(slug, value),
          price: price.toFixed(2),
          stock: soldOut ? 0 : stockEach,
          optionKey: buildOptionKey(optionValueIds),
          optionValues: {
            create: optionValueIds.map((optionValueId) => ({ optionValueId })),
          },
        };
      });

      const product = await prisma.product.create({
        data: {
          name: p.title,
          slug,
          description: p.description,
          shortDescription: p.description.split('. ')[0].replace(/\.?$/, '.'),
          status: 'ACTIVE',
          brandId: p.brand ? deps.brands.get(p.brand) : null,
          images: {
            create: p.images.map((url, i) => ({
              url,
              altText: `${p.title} — image ${i + 1}`,
              isPrimary: i === 0,
              position: i,
            })),
          },
          categories: {
            create: [
              { categoryId: category.id, isPrimary: true },
              { categoryId: category.parentId, isPrimary: false },
            ],
          },
          tags: {
            create: p.tags.map((t) => ({ tagId: deps.tags.get(t)! })),
          },
          options: option ? { create: { optionId: option.id } } : undefined,
          variants: { create: variants },
        },
      });

      const { count } = await prisma.review.createMany({
        data: p.reviews.map((r, i) => ({
          productId: product.id,
          userId: deps.users.get(r.reviewerEmail)!,
          rating: r.rating,
          title: r.comment,
          body: `${r.comment} ${p.title} works as described.`,
          // Leave a few in the moderation queue.
          status: (index + i) % 7 === 0 ? 'PENDING' : 'APPROVED',
        })),
        skipDuplicates: true,
      });
      reviews += count;
    }
  }

  log('products', created, total);
  console.log(`  ${'reviews'.padEnd(18)} ${reviews} created`);
}

async function seedCampaigns(deps: {
  categories: Awaited<ReturnType<typeof seedCategories>>;
  brands: Map<string, string>;
}) {
  const productIds = async (slugs: string[]) =>
    (
      await prisma.product.findMany({
        where: { slug: { in: slugs } },
        select: { id: true, slug: true },
      })
    ).sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug));

  const campaigns = [
    {
      slug: 'winter-sale-2026',
      name: 'Winter Sale 2026',
      description: 'Up to 30% off sneakers, smartphones and laptops.',
      status: 'ACTIVE' as const,
      startsAt: new Date(NOW - 2 * DAY),
      endsAt: new Date(NOW + 30 * DAY),
      isFeatured: true,
      sections: [
        {
          title: 'Sneaker Deals',
          slug: 'sneaker-deals',
          products: [
            'nike-air-jordan-1-red-and-black',
            'puma-future-rider-trainers',
            'sports-sneakers-off-white-red',
            'nike-baseball-cleats',
          ],
          rules: [],
        },
        {
          title: 'Smartphones under ৳40,000',
          slug: 'budget-smartphones',
          products: [],
          rules: [
            {
              categoryId: deps.categories.bySlug.get('smartphones'),
              maxPrice: '40000',
              matchType: 'ALL' as const,
            },
          ],
        },
        {
          title: 'Laptops for Work',
          slug: 'laptops-for-work',
          products: [],
          rules: [
            {
              categoryId: deps.categories.bySlug.get('laptops'),
              matchType: 'ALL' as const,
            },
          ],
        },
      ],
    },
    {
      slug: 'eid-collection-2026',
      name: 'Eid Collection 2026',
      description: 'Festive fashion, bags and luxury watches.',
      status: 'SCHEDULED' as const,
      startsAt: new Date(NOW + 20 * DAY),
      endsAt: new Date(NOW + 35 * DAY),
      isFeatured: false,
      sections: [
        {
          title: 'Luxury Watches',
          slug: 'luxury-watches',
          products: [],
          rules: [
            { brandId: deps.brands.get('Rolex'), matchType: 'ANY' as const },
          ],
        },
        {
          title: 'Festive Dresses',
          slug: 'festive-dresses',
          products: ['tartan-dress', 'gray-dress', 'blue-frock'],
          rules: [],
        },
      ],
    },
  ];

  const ids = new Map<string, string>();
  let created = 0;

  for (const c of campaigns) {
    const existing = await prisma.campaign.findUnique({
      where: { slug: c.slug },
    });
    if (existing) {
      ids.set(c.slug, existing.id);
      continue;
    }
    created++;

    const sections: Prisma.CampaignSectionCreateWithoutCampaignInput[] = [];
    for (const [position, s] of c.sections.entries()) {
      const products = await productIds(s.products);
      sections.push({
        title: s.title,
        slug: s.slug,
        position,
        bannerUrl: photo(`${c.slug}-${s.slug}`, 1200, 300),
        products: {
          create: products.map((p, i) => ({ productId: p.id, position: i })),
        },
        campaignRules: { create: s.rules },
      });
    }

    const row = await prisma.campaign.create({
      data: {
        slug: c.slug,
        name: c.name,
        description: c.description,
        status: c.status,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        isFeatured: c.isFeatured,
        bannerUrl: photo(c.slug, 1600, 500),
        thumbnailUrl: photo(`${c.slug}-thumb`, 600, 400),
        metaTitle: c.name,
        metaDescription: c.description,
        metaImageUrl: photo(`${c.slug}-og`, 1200, 630),
        banners: {
          create: [0, 1].map((position) => ({
            title: position === 0 ? c.name : `${c.name} — Shop now`,
            imageUrl: photo(`${c.slug}-banner-${position}`, 1600, 500),
            mobileImageUrl: photo(`${c.slug}-banner-${position}-m`, 800, 600),
            linkUrl: `/campaigns/${c.slug}`,
            position,
          })),
        },
        sections: { create: sections },
      },
    });
    ids.set(c.slug, row.id);
  }

  log('campaigns', created, campaigns.length);
  return ids;
}

async function seedPromotions(deps: {
  categories: Awaited<ReturnType<typeof seedCategories>>;
  brands: Map<string, string>;
  tags: Map<string, string>;
  campaigns: Map<string, string>;
}) {
  const variant = await prisma.productVariant.findUnique({
    where: { sku: skuFor('iphone-13-pro', '128GB') },
    select: { id: true },
  });

  type Target = { targetType: PromotionTargetType } & Partial<
    Record<
      'productId' | 'variantId' | 'categoryId' | 'brandId' | 'tagId',
      string
    >
  >;
  const promotions: {
    name: string;
    description: string;
    type: PromotionType;
    status: PromotionStatus;
    scope: PromotionScope;
    value?: string;
    buyQuantity?: number;
    getQuantity?: number;
    minOrderAmount?: string;
    maxDiscountAmount?: string;
    priority?: number;
    startsAt?: Date;
    endsAt?: Date;
    targets?: Target[];
    campaigns?: string[];
  }[] = [
    {
      name: 'Nike 20% Off',
      description: '20% off every Nike product during the Winter Sale.',
      type: 'PERCENTAGE',
      status: 'ACTIVE',
      scope: 'SPECIFIC',
      value: '20',
      priority: 10,
      targets: [{ targetType: 'BRAND', brandId: deps.brands.get('Nike') }],
      campaigns: ['winter-sale-2026'],
    },
    {
      name: '৳5,000 Off Laptops',
      description: 'Flat ৳5,000 off any laptop.',
      type: 'FIXED_AMOUNT',
      status: 'ACTIVE',
      scope: 'SPECIFIC',
      value: '5000',
      priority: 5,
      targets: [
        {
          targetType: 'CATEGORY',
          categoryId: deps.categories.bySlug.get('laptops'),
        },
      ],
      campaigns: ['winter-sale-2026'],
    },
    {
      name: 'iPhone 13 Pro Flash Price',
      description: 'iPhone 13 Pro 128GB for ৳119,999.',
      type: 'FIXED_PRICE',
      status: 'ACTIVE',
      scope: 'SPECIFIC',
      value: '119999',
      priority: 20,
      startsAt: new Date(NOW - DAY),
      endsAt: new Date(NOW + 3 * DAY),
      targets: variant
        ? [{ targetType: 'VARIANT', variantId: variant.id }]
        : [],
    },
    {
      name: 'Sunglasses Buy 2 Get 1',
      description: 'Buy any 2 sunglasses, get the 3rd free.',
      type: 'BUY_X_GET_Y',
      status: 'ACTIVE',
      scope: 'SPECIFIC',
      buyQuantity: 2,
      getQuantity: 1,
      targets: [{ targetType: 'TAG', tagId: deps.tags.get('sunglasses') }],
    },
    {
      name: 'Sitewide 5% Off',
      description: '5% off everything, capped at ৳1,000.',
      type: 'PERCENTAGE',
      status: 'ACTIVE',
      scope: 'ALL',
      value: '5',
      maxDiscountAmount: '1000',
    },
    {
      name: 'Free Shipping over ৳5,000',
      description: 'Free delivery on orders of ৳5,000 or more.',
      type: 'FREE_SHIPPING',
      status: 'ACTIVE',
      scope: 'ALL',
      minOrderAmount: '5000',
    },
    {
      name: '৳60 Off Shipping',
      description: 'Shipping discount for fashion orders.',
      type: 'SHIPPING_DISCOUNT',
      status: 'ACTIVE',
      scope: 'SPECIFIC',
      value: '60',
      targets: [
        {
          targetType: 'CATEGORY',
          categoryId: deps.categories.bySlug.get('fashion'),
        },
      ],
    },
    {
      name: 'Eid Watch Week',
      description: '10% off Rolex during the Eid Collection.',
      type: 'PERCENTAGE',
      status: 'SCHEDULED',
      scope: 'SPECIFIC',
      value: '10',
      startsAt: new Date(NOW + 20 * DAY),
      endsAt: new Date(NOW + 27 * DAY),
      targets: [{ targetType: 'BRAND', brandId: deps.brands.get('Rolex') }],
      campaigns: ['eid-collection-2026'],
    },
    {
      name: 'Summer Dress Clearance',
      description: 'Draft — not live yet.',
      type: 'PERCENTAGE',
      status: 'DRAFT',
      scope: 'SPECIFIC',
      value: '30',
      targets: [
        {
          targetType: 'CATEGORY',
          categoryId: deps.categories.bySlug.get('womens-dresses'),
        },
      ],
    },
    {
      name: 'Back to School 2026',
      description: 'Ended promotion, kept for history.',
      type: 'FIXED_AMOUNT',
      status: 'ENDED',
      scope: 'SPECIFIC',
      value: '2000',
      startsAt: new Date(NOW - 60 * DAY),
      endsAt: new Date(NOW - 30 * DAY),
      targets: [
        {
          targetType: 'CATEGORY',
          categoryId: deps.categories.bySlug.get('laptops'),
        },
      ],
    },
  ];

  let created = 0;
  for (const { targets = [], campaigns = [], ...p } of promotions) {
    if (await prisma.promotion.findFirst({ where: { name: p.name } })) continue;
    created++;
    await prisma.promotion.create({
      data: {
        ...p,
        targets: { create: targets },
        campaigns: {
          create: campaigns.map((slug) => ({
            campaignId: deps.campaigns.get(slug)!,
          })),
        },
      },
    });
  }

  log('promotions', created, promotions.length);
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('Seeding database…');
  const categories = await seedCategories();
  const brands = await seedBrands();
  const tags = await seedTags();
  const options = await seedOptions();
  await seedTemplates(options);
  const users = await seedUsers();
  await seedProducts({ categories, brands, tags, options, users });
  const campaigns = await seedCampaigns({ categories, brands });
  await seedPromotions({ categories, brands, tags, campaigns });
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
