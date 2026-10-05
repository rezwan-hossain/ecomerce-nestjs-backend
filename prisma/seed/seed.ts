/**
 * Development seed: catalog, users, reviews, campaigns, promotions and
 * inventory (warehouses, racks, suppliers, purchase orders, transfers,
 * adjustments, reorder rules and alerts).
 *
 *   npx prisma db seed
 *
 * Idempotent — every row is looked up by its natural key (slug, name, email,
 * SKU) first and only created when missing, so re-running is a no-op and rows
 * you already have (e.g. the "Nike" brand) are reused, never modified.
 *
 * Inventory documents (POs, transfers, adjustments) are keyed by their number
 * and booked through InventoryService.applyMovement(), so levels, rack stock,
 * the movement ledger and ProductVariant.stock stay consistent.
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
  AdjustmentReason,
  AdjustmentStatus,
  AdjustmentType,
  InventoryAlertType,
  MovementType,
  PurchaseOrderItemStatus,
  PurchaseOrderStatus,
  PromotionTargetType,
  PromotionType,
  PromotionScope,
  PromotionStatus,
  TransferStatus,
} from '../../src/generated/prisma/enums';
import { createSlug } from '../../src/common/utils/slug.util';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
// Only uses the Prisma client, so it can run outside the Nest container.
const inventory = new InventoryService(prisma as unknown as PrismaService);

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
/** Landed cost as a share of the selling price. */
const COST_RATIO = 0.6;
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

const costOf = (price: Prisma.Decimal | string | number) =>
  new Prisma.Decimal(price).mul(COST_RATIO).toDecimalPlaces(2);

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

// ─── Warehouses & suppliers ───────────────────────────────────

const WAREHOUSES = [
  // MAIN also exists after the inventory migration; upsert keeps it in sync.
  {
    code: 'MAIN',
    name: 'Main Warehouse',
    type: 'PHYSICAL',
    isDefault: true,
    priority: 100,
    city: 'Dhaka',
  },
  {
    code: 'CTG-STORE',
    name: 'Chattogram Store',
    type: 'STORE',
    isDefault: false,
    priority: 50,
    city: 'Chattogram',
  },
  {
    code: 'RETURNS',
    name: 'Returns Processing',
    type: 'VIRTUAL_RETURN',
    isDefault: false,
    priority: 0,
    city: 'Dhaka',
  },
  {
    code: 'DAMAGE',
    name: 'Damaged Goods Hold',
    type: 'VIRTUAL_DAMAGE',
    isDefault: false,
    priority: 0,
    city: 'Dhaka',
  },
] as const;

async function seedWarehouses() {
  const ids = new Map<string, string>();
  let created = 0;
  for (const { code, ...data } of WAREHOUSES) {
    let row = await prisma.warehouse.findUnique({ where: { code } });
    if (!row) {
      row = await prisma.warehouse.create({
        data: { code, country: 'BD', ...data },
      });
      created++;
    }
    ids.set(code, row.id);
  }
  log('warehouses', created, WAREHOUSES.length);
  return ids;
}

// Racks in MAIN: two aisles (A, B) of four racks, walked A-01 → B-04, plus a
// receiving dock that's only picked from when the racks run out.
const MAIN_RACKS = [
  ...['A', 'B'].flatMap((aisle, a) =>
    [1, 2, 3, 4].map((n) => ({
      code: `${aisle}-0${n}`,
      name: `Aisle ${aisle}, rack ${n}`,
      type: 'RACK' as const,
      isPickable: true,
      pickSequence: a * 10 + n,
    })),
  ),
  {
    code: 'DOCK-01',
    name: 'Receiving dock',
    type: 'RECEIVING' as const,
    isPickable: false,
    pickSequence: 900,
  },
];

/** UNASSIGNED in every warehouse, demo racks in MAIN. Returns MAIN rack ids. */
async function seedLocations(warehouses: Map<string, string>) {
  const wanted = [
    ...[...warehouses.values()].map((warehouseId) => ({
      warehouseId,
      code: 'UNASSIGNED',
      name: 'Unassigned',
      type: 'STAGING' as const,
      isPickable: true,
      pickSequence: 999999,
    })),
    ...MAIN_RACKS.map((r) => ({ warehouseId: warehouses.get('MAIN')!, ...r })),
  ];

  let created = 0;
  const mainRacks = new Map<string, string>();
  for (const { warehouseId, code, ...data } of wanted) {
    let row = await prisma.storageLocation.findUnique({
      where: { warehouseId_code: { warehouseId, code } },
    });
    if (!row) {
      row = await prisma.storageLocation.create({
        data: { warehouseId, code, ...data },
      });
      created++;
    }
    if (warehouseId === warehouses.get('MAIN')) mainRacks.set(code, row.id);
  }
  log('storage locations', created, wanted.length);
  return mainRacks;
}

const SUPPLIERS = [
  {
    code: 'SUP-001',
    name: 'Dhaka Wholesale Traders',
    paymentTerms: 'Net 30',
    leadTimeDays: 7,
  },
  {
    code: 'SUP-002',
    name: 'Global Imports Ltd',
    paymentTerms: 'COD',
    leadTimeDays: 21,
  },
];

async function seedSuppliers() {
  const ids = new Map<string, string>();
  let created = 0;
  for (const { code, ...data } of SUPPLIERS) {
    let row = await prisma.supplier.findUnique({ where: { code } });
    if (!row) {
      row = await prisma.supplier.create({
        data: { code, country: 'BD', ...data },
      });
      created++;
    }
    ids.set(code, row.id);
  }
  log('suppliers', created, SUPPLIERS.length);
  return ids;
}

async function seedProducts(deps: {
  warehouses: Map<string, string>;
  mainRacks: Map<string, string>;
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
  // Each new variant gets a default rack, round-robin over the A/B racks.
  const rackIds = MAIN_RACKS.filter((r) => r.type === 'RACK').map(
    (r) => deps.mainRacks.get(r.code)!,
  );
  let rackCursor = 0;

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
        const stock = soldOut ? 0 : stockEach;
        const rackId = rackIds[rackCursor++ % rackIds.length];
        const unitCost = costOf(price);
        return {
          sku: skuFor(slug, value),
          price: price.toFixed(2),
          // Denormalized from the MAIN level below (see InventoryService).
          stock,
          // Opening stock lives at the default warehouse, with its ledger row.
          inventoryLevels: {
            create: {
              warehouseId: deps.warehouses.get('MAIN')!,
              onHand: stock,
              available: stock,
              unitCost,
              totalCost: unitCost.mul(stock),
              defaultLocationId: rackId,
              // Racks must add up to onHand: all of it sits on the default rack.
              locationStocks: stock
                ? { create: { locationId: rackId, quantity: stock } }
                : undefined,
              movements: stock
                ? {
                    create: {
                      type: 'INITIAL_STOCK' as const,
                      direction: 'IN' as const,
                      quantity: stock,
                      onHandBefore: 0,
                      onHandAfter: stock,
                      unitCost,
                      totalCost: unitCost.mul(stock),
                      toLocationId: rackId,
                      note: 'Seed opening stock',
                    },
                  }
                : undefined,
            },
          },
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

// ─── Inventory operations ─────────────────────────────────────
//
// Each document is created once, keyed by its number, and its stock effect
// is booked in the same transaction. Lines whose stock isn't there any more
// (e.g. you sold it through the API) skip the whole document with a warning.

interface InventoryDeps {
  warehouses: Map<string, string>;
  suppliers: Map<string, string>;
  adminId: string;
}

const TX_OPTIONS = { timeout: 60_000 };

const ago = (days?: number) =>
  days === undefined ? null : new Date(NOW - days * DAY);
const ahead = (days?: number) =>
  days === undefined ? null : new Date(NOW + days * DAY);

/** SKU → variant, or null (with a warning) when any SKU is missing. */
async function variantsBySku(doc: string, skus: string[]) {
  const rows = await prisma.productVariant.findMany({
    where: { sku: { in: skus } },
    select: {
      id: true,
      sku: true,
      price: true,
      inventoryLevels: {
        select: {
          warehouseId: true,
          onHand: true,
          available: true,
          unitCost: true,
        },
      },
    },
  });
  const bySku = new Map(rows.map((v) => [v.sku, v]));
  const missing = skus.filter((sku) => !bySku.has(sku));
  if (missing.length) {
    console.warn(`  ! ${doc} skipped: unknown SKU(s) ${missing.join(', ')}`);
    return null;
  }
  return bySku;
}

type SeedVariant =
  NonNullable<Awaited<ReturnType<typeof variantsBySku>>> extends Map<
    string,
    infer V
  >
    ? V
    : never;

const levelAt = (v: SeedVariant, warehouseId: string) =>
  v.inventoryLevels.find((l) => l.warehouseId === warehouseId);

/** Adds open (ordered or in-transit, not yet booked) units to `incoming`. */
async function addIncoming(
  tx: Prisma.TransactionClient,
  variantId: string,
  warehouseId: string,
  quantity: number,
) {
  if (quantity <= 0) return;
  await inventory.ensureLevel(tx, variantId, warehouseId);
  await tx.inventoryLevel.update({
    where: { variantId_warehouseId: { variantId, warehouseId } },
    data: { incoming: { increment: quantity } },
  });
}

async function seedReorderRules(deps: InventoryDeps) {
  const mainId = deps.warehouses.get('MAIN')!;
  const variants = await prisma.productVariant.findMany({
    where: { inventoryLevels: { some: { warehouseId: mainId } } },
    select: {
      id: true,
      product: {
        select: {
          categories: {
            where: { category: { slug: 'electronics' } },
            select: { categoryId: true },
          },
        },
      },
    },
  });

  const { count } = await prisma.reorderRule.createMany({
    data: variants.map((v) => {
      // Electronics are imported: smaller, rarer orders, drafted automatically.
      const imported = v.product.categories.length > 0;
      return {
        variantId: v.id,
        warehouseId: mainId,
        reorderPoint: imported ? 3 : 5,
        reorderQty: imported ? 10 : 24,
        safetyStock: imported ? 1 : 2,
        maxStock: imported ? 60 : 120,
        autoReorder: imported,
        preferredSupplierId: deps.suppliers.get(
          imported ? 'SUP-002' : 'SUP-001',
        ),
      };
    }),
    skipDuplicates: true,
  });
  log('reorder rules', count, variants.length);
}

/** Statuses whose unreceived quantity counts as `incoming`. */
const OPEN_PO_STATUSES: PurchaseOrderStatus[] = [
  'SUBMITTED',
  'CONFIRMED',
  'PARTIAL',
];

const PURCHASE_ORDERS: {
  poNumber: string;
  supplier: string;
  status: PurchaseOrderStatus;
  orderedDaysAgo?: number;
  expectedInDays?: number;
  receivedDaysAgo?: number; // when the received lines arrived
  note: string;
  lines: { sku: string; ordered: number; received?: number; batch?: string }[];
}[] = [
  {
    poNumber: 'PO-2026-00001',
    supplier: 'SUP-002',
    status: 'RECEIVED',
    orderedDaysAgo: 20,
    expectedInDays: -12,
    receivedDaysAgo: 12,
    note: 'Restock of best-selling Apple devices.',
    lines: [
      {
        sku: 'IPHONE-13-PRO-128GB',
        ordered: 20,
        received: 20,
        batch: 'APL-2609-A',
      },
      {
        sku: 'APPLE-MACBOOK-PRO-14-INCH-SPACE-GREY-16GB',
        ordered: 10,
        received: 10,
        batch: 'APL-2609-B',
      },
    ],
  },
  {
    poNumber: 'PO-2026-00002',
    supplier: 'SUP-001',
    status: 'PARTIAL',
    orderedDaysAgo: 10,
    expectedInDays: 3,
    receivedDaysAgo: 2,
    note: 'Puma trainers — supplier is shipping in two lots.',
    lines: [
      {
        sku: 'PUMA-FUTURE-RIDER-TRAINERS-40',
        ordered: 24,
        received: 24,
        batch: 'PUM-2610-01',
      },
      {
        sku: 'PUMA-FUTURE-RIDER-TRAINERS-41',
        ordered: 24,
        received: 12,
        batch: 'PUM-2610-02',
      },
      { sku: 'PUMA-FUTURE-RIDER-TRAINERS-42', ordered: 24 },
    ],
  },
  {
    poNumber: 'PO-2026-00003',
    supplier: 'SUP-001',
    status: 'CONFIRMED',
    orderedDaysAgo: 3,
    expectedInDays: 5,
    note: 'Short sleeve shirts are nearly sold out.',
    lines: ['S', 'M', 'L', 'XL'].map((size) => ({
      sku: `MAN-SHORT-SLEEVE-SHIRT-${size}`,
      ordered: 30,
    })),
  },
  {
    poNumber: 'PO-2026-00004',
    supplier: 'SUP-002',
    status: 'DRAFT',
    note: 'Draft — waiting on a price quote.',
    lines: [
      { sku: 'SAMSUNG-GALAXY-S8-128GB', ordered: 15 },
      { sku: 'SAMSUNG-GALAXY-S8-256GB', ordered: 15 },
    ],
  },
];

async function seedPurchaseOrders(deps: InventoryDeps) {
  const mainId = deps.warehouses.get('MAIN')!;
  let created = 0;

  for (const po of PURCHASE_ORDERS) {
    if (
      await prisma.purchaseOrder.findUnique({
        where: { poNumber: po.poNumber },
      })
    )
      continue;
    const variants = await variantsBySku(
      po.poNumber,
      po.lines.map((l) => l.sku),
    );
    if (!variants) continue;

    const supplierId = deps.suppliers.get(po.supplier)!;
    const lines = po.lines.map((l) => {
      const variant = variants.get(l.sku)!;
      const received = l.received ?? 0;
      const unitCost = costOf(variant.price);
      return {
        ...l,
        received,
        variantId: variant.id,
        unitCost,
        totalCost: unitCost.mul(l.ordered),
        status: (received === l.ordered
          ? 'RECEIVED'
          : received > 0
            ? 'PARTIAL'
            : 'PENDING') as PurchaseOrderItemStatus,
      };
    });
    const subtotal = lines.reduce(
      (sum, l) => sum.plus(l.totalCost),
      new Prisma.Decimal(0),
    );

    await prisma.$transaction(async (tx) => {
      const order = await tx.purchaseOrder.create({
        data: {
          poNumber: po.poNumber,
          supplierId,
          status: po.status,
          subtotalAmount: subtotal.toDecimalPlaces(2),
          totalAmount: subtotal.toDecimalPlaces(2),
          orderedAt: ago(po.orderedDaysAgo),
          expectedAt: ahead(po.expectedInDays),
          receivedAt: po.status === 'RECEIVED' ? ago(po.receivedDaysAgo) : null,
          createdByUserId: deps.adminId,
          approvedByUserId: po.status === 'DRAFT' ? null : deps.adminId,
          note: po.note,
          items: {
            create: lines.map((l) => ({
              variantId: l.variantId,
              warehouseId: mainId,
              orderedQty: l.ordered,
              receivedQty: l.received,
              unitCost: l.unitCost,
              totalCost: l.totalCost,
              status: l.status,
            })),
          },
        },
        include: { items: true },
      });

      for (const line of lines) {
        if (line.received) {
          const item = order.items.find((i) => i.variantId === line.variantId)!;
          const batch = await tx.inventoryBatch.create({
            data: {
              variantId: line.variantId,
              warehouseId: mainId,
              batchNumber: line.batch!,
              quantity: line.received,
              initialQty: line.received,
              unitCost: line.unitCost,
              receivedAt: ago(po.receivedDaysAgo),
              supplierId,
              purchaseOrderItemId: item.id,
            },
          });
          await inventory.applyMovement(tx, {
            variantId: line.variantId,
            warehouseId: mainId,
            type: 'PURCHASE_RECEIVED',
            quantity: line.received,
            unitCost: line.unitCost,
            referenceType: 'PURCHASE_ORDER',
            referenceId: order.id,
            batchId: batch.id,
            userId: deps.adminId,
            note: `Received on ${po.poNumber}`,
          });
        }
        if (OPEN_PO_STATUSES.includes(po.status))
          await addIncoming(
            tx,
            line.variantId,
            mainId,
            line.ordered - line.received,
          );
      }
    }, TX_OPTIONS);
    created++;
  }

  log('purchase orders', created, PURCHASE_ORDERS.length);
}

const TRANSFERS: {
  transferNumber: string;
  from: string;
  to: string;
  status: TransferStatus;
  shippedDaysAgo: number;
  receivedDaysAgo?: number;
  note: string;
  lines: { sku: string; quantity: number }[];
}[] = [
  {
    transferNumber: 'TRF-2026-00001',
    from: 'MAIN',
    to: 'CTG-STORE',
    status: 'COMPLETED',
    shippedDaysAgo: 6,
    receivedDaysAgo: 4,
    note: 'Stock the Chattogram store with accessories.',
    lines: [
      { sku: 'PRADA-WOMEN-BAG', quantity: 10 },
      { sku: 'ROLEX-SUBMARINER-WATCH', quantity: 5 },
      { sku: 'BLACK-SUN-GLASSES', quantity: 15 },
    ],
  },
  {
    transferNumber: 'TRF-2026-00002',
    from: 'MAIN',
    to: 'CTG-STORE',
    status: 'IN_TRANSIT',
    shippedDaysAgo: 1,
    note: 'Plaid shirts for the store window.',
    lines: [
      { sku: 'MAN-PLAID-SHIRT-M', quantity: 6 },
      { sku: 'MAN-PLAID-SHIRT-L', quantity: 6 },
    ],
  },
];

async function seedTransfers(deps: InventoryDeps) {
  let created = 0;

  for (const t of TRANSFERS) {
    if (
      await prisma.inventoryTransfer.findUnique({
        where: { transferNumber: t.transferNumber },
      })
    )
      continue;
    const variants = await variantsBySku(
      t.transferNumber,
      t.lines.map((l) => l.sku),
    );
    if (!variants) continue;

    const fromId = deps.warehouses.get(t.from)!;
    const toId = deps.warehouses.get(t.to)!;
    const short = t.lines.filter(
      (l) =>
        (levelAt(variants.get(l.sku)!, fromId)?.available ?? 0) < l.quantity,
    );
    if (short.length) {
      console.warn(
        `  ! ${t.transferNumber} skipped: not enough stock of ${short.map((l) => l.sku).join(', ')}`,
      );
      continue;
    }

    const completed = t.status === 'COMPLETED';
    const lines = t.lines.map((l) => {
      const variant = variants.get(l.sku)!;
      return {
        ...l,
        variantId: variant.id,
        unitCost: levelAt(variant, fromId)!.unitCost,
      };
    });

    await prisma.$transaction(async (tx) => {
      const transfer = await tx.inventoryTransfer.create({
        data: {
          transferNumber: t.transferNumber,
          fromWarehouseId: fromId,
          toWarehouseId: toId,
          status: t.status,
          initiatedByUserId: deps.adminId,
          receivedByUserId: completed ? deps.adminId : null,
          shippedAt: ago(t.shippedDaysAgo),
          receivedAt: completed ? ago(t.receivedDaysAgo) : null,
          note: t.note,
          items: {
            create: lines.map((l) => ({
              variantId: l.variantId,
              sentQty: l.quantity,
              receivedQty: completed ? l.quantity : 0,
              unitCost: l.unitCost,
            })),
          },
        },
      });

      const ref = {
        referenceType: 'TRANSFER' as const,
        referenceId: transfer.id,
        sourceWarehouseId: fromId,
        destWarehouseId: toId,
        userId: deps.adminId,
        note: t.transferNumber,
      };
      for (const line of lines) {
        await inventory.applyMovement(tx, {
          ...ref,
          variantId: line.variantId,
          warehouseId: fromId,
          type: 'TRANSFER_OUT',
          quantity: line.quantity,
        });
        if (completed) {
          await inventory.ensureLevel(tx, line.variantId, toId);
          await inventory.applyMovement(tx, {
            ...ref,
            variantId: line.variantId,
            warehouseId: toId,
            type: 'TRANSFER_IN',
            quantity: line.quantity,
            unitCost: line.unitCost,
          });
        } else {
          await addIncoming(tx, line.variantId, toId, line.quantity);
        }
      }
    }, TX_OPTIONS);
    created++;
  }

  log('transfers', created, TRANSFERS.length);
}

const ADJUSTMENTS: {
  adjustmentNumber: string;
  type: AdjustmentType;
  reason: AdjustmentReason;
  status: AdjustmentStatus;
  note: string;
  // `delta` is the change to onHand at MAIN; `movement` overrides the
  // default ADJUSTMENT_INCREASE / ADJUSTMENT_DECREASE ledger type.
  lines: { sku: string; delta: number; movement?: MovementType }[];
}[] = [
  {
    adjustmentNumber: 'ADJ-2026-00001',
    type: 'DECREASE',
    reason: 'DAMAGE',
    status: 'APPLIED',
    note: 'Water damage found while unpacking.',
    lines: [
      { sku: 'PUMA-FUTURE-RIDER-TRAINERS-44', delta: -2, movement: 'DAMAGED' },
    ],
  },
  {
    adjustmentNumber: 'ADJ-2026-00002',
    type: 'CYCLE_COUNT',
    reason: 'CYCLE_COUNT',
    status: 'APPLIED',
    note: 'Weekly count of high-value watches.',
    lines: [
      { sku: 'ROLEX-SUBMARINER-WATCH', delta: -1 },
      { sku: 'ROLEX-DATEJUST', delta: 0 },
    ],
  },
  {
    adjustmentNumber: 'ADJ-2026-00003',
    type: 'INCREASE',
    reason: 'CORRECTION',
    status: 'PENDING',
    note: 'Extra units found at the receiving dock — awaiting approval.',
    lines: [{ sku: 'CLASSIC-SUN-GLASSES', delta: 5 }],
  },
];

async function seedAdjustments(deps: InventoryDeps) {
  const mainId = deps.warehouses.get('MAIN')!;
  let created = 0;

  for (const a of ADJUSTMENTS) {
    if (
      await prisma.stockAdjustment.findUnique({
        where: { adjustmentNumber: a.adjustmentNumber },
      })
    )
      continue;
    const variants = await variantsBySku(
      a.adjustmentNumber,
      a.lines.map((l) => l.sku),
    );
    if (!variants) continue;

    const applied = a.status === 'APPLIED';
    const lines = a.lines.map((l) => {
      const variant = variants.get(l.sku)!;
      const level = levelAt(variant, mainId);
      return { ...l, variantId: variant.id, level };
    });
    const short = lines.filter(
      (l) => !l.level || (applied && l.level.available + l.delta < 0),
    );
    if (short.length) {
      console.warn(
        `  ! ${a.adjustmentNumber} skipped: not enough stock of ${short.map((l) => l.sku).join(', ')}`,
      );
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const adjustment = await tx.stockAdjustment.create({
        data: {
          adjustmentNumber: a.adjustmentNumber,
          type: a.type,
          reason: a.reason,
          status: a.status,
          createdByUserId: deps.adminId,
          approvedByUserId: applied ? deps.adminId : null,
          approvedAt: applied ? new Date(NOW) : null,
          appliedAt: applied ? new Date(NOW) : null,
          note: a.note,
          items: {
            create: lines.map((l) => ({
              variantId: l.variantId,
              warehouseId: mainId,
              ...(a.type === 'CYCLE_COUNT' && {
                expectedQty: l.level!.onHand,
                actualQty: l.level!.onHand + l.delta,
              }),
              adjustmentQty: l.delta,
              unitCost: l.level!.unitCost,
            })),
          },
        },
      });

      if (!applied) return;
      for (const line of lines) {
        if (!line.delta) continue;
        await inventory.applyMovement(tx, {
          variantId: line.variantId,
          warehouseId: mainId,
          type:
            line.movement ??
            (line.delta > 0 ? 'ADJUSTMENT_INCREASE' : 'ADJUSTMENT_DECREASE'),
          quantity: Math.abs(line.delta),
          referenceType: 'ADJUSTMENT',
          referenceId: adjustment.id,
          userId: deps.adminId,
          note: `${a.adjustmentNumber}: ${a.note}`,
        });
      }
    }, TX_OPTIONS);
    created++;
  }

  log('adjustments', created, ADJUSTMENTS.length);
}

/**
 * Raises LOW_STOCK / OUT_OF_STOCK alerts at MAIN from the reorder rules,
 * once per variant and type (a resolved alert isn't raised again).
 */
async function seedAlerts(deps: InventoryDeps) {
  const mainId = deps.warehouses.get('MAIN')!;
  const rules = await prisma.reorderRule.findMany({
    where: { warehouseId: mainId, isActive: true },
    select: {
      variantId: true,
      reorderPoint: true,
      variant: {
        select: {
          sku: true,
          inventoryLevels: {
            where: { warehouseId: mainId },
            select: { available: true },
          },
        },
      },
    },
  });
  const existing = await prisma.inventoryAlert.findMany({
    where: { warehouseId: mainId },
    select: { variantId: true, type: true },
  });
  const seen = new Set(existing.map((a) => `${a.variantId}:${a.type}`));

  const data: Prisma.InventoryAlertCreateManyInput[] = [];
  let total = 0;
  for (const r of rules) {
    const available = r.variant.inventoryLevels[0]?.available ?? 0;
    const type: InventoryAlertType | null =
      available === 0
        ? 'OUT_OF_STOCK'
        : available <= r.reorderPoint
          ? 'LOW_STOCK'
          : null;
    if (!type) continue;
    total++;
    if (seen.has(`${r.variantId}:${type}`)) continue;
    data.push({
      variantId: r.variantId,
      warehouseId: mainId,
      type,
      title:
        type === 'OUT_OF_STOCK'
          ? `${r.variant.sku} is out of stock`
          : `${r.variant.sku} is running low`,
      message: `${available} available at Main Warehouse (reorder point ${r.reorderPoint}).`,
      currentStock: available,
      threshold: r.reorderPoint,
    });
  }

  const { count } = await prisma.inventoryAlert.createMany({
    data,
    skipDuplicates: true,
  });
  log('inventory alerts', count, total);
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
  const warehouses = await seedWarehouses();
  const mainRacks = await seedLocations(warehouses);
  const suppliers = await seedSuppliers();
  await seedProducts({
    warehouses,
    mainRacks,
    categories,
    brands,
    tags,
    options,
    users,
  });
  const campaigns = await seedCampaigns({ categories, brands });
  await seedPromotions({ categories, brands, tags, campaigns });

  const ops = {
    warehouses,
    suppliers,
    adminId: users.get('admin@shop.test')!,
  };
  await seedReorderRules(ops);
  await seedPurchaseOrders(ops);
  await seedTransfers(ops);
  await seedAdjustments(ops);
  await seedAlerts(ops);
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
