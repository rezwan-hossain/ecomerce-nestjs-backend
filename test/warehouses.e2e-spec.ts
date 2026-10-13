import {
  bootApp,
  body,
  createVariant,
  levelOf,
  runTag,
  stockIn,
} from './inventory-fixtures';

const RUN = runTag();
type One<T = Record<string, unknown>> = { data: T };
type Wh = {
  id: string;
  code: string;
  isActive: boolean;
  counts: {
    locations: number;
    variantsStocked: number;
    unitsOnHand: number;
    stockValue: string;
  };
};

describe('Warehouses (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (ctx = await bootApp()));
  afterAll(async () => {
    await ctx.app.close();
    await ctx.prisma.$disconnect();
  });

  it('creates, lists with counts, and keeps code fixed', async () => {
    const created = await ctx
      .api()
      .post('/inventory/warehouses')
      .send({ code: `E2E-${RUN}-A`, name: `E2E ${RUN} A`, city: 'Dhaka' })
      .expect(201);
    const wh = body<One<Wh>>(created).data;
    expect(wh).toMatchObject({
      code: `E2E-${RUN}-A`,
      isActive: true,
      counts: { locations: 0, unitsOnHand: 0 },
    });
    // UNASSIGNED exists but isn't counted
    await ctx.prisma.storageLocation.findUniqueOrThrow({
      where: { warehouseId_code: { warehouseId: wh.id, code: 'UNASSIGNED' } },
    });

    const variant = await createVariant(ctx.prisma, RUN, 'A1');
    await stockIn(ctx.prisma, ctx.inventory, variant.id, wh.id, 5, 20);

    const list = body<{ data: Wh[] }>(
      await ctx.api().get('/inventory/warehouses').expect(200),
    );
    expect(list.data.find((w) => w.id === wh.id)?.counts).toMatchObject({
      variantsStocked: 1,
      unitsOnHand: 5,
    });
    expect(
      Number(list.data.find((w) => w.id === wh.id)?.counts.stockValue),
    ).toBe(100);

    await ctx
      .api()
      .patch(`/inventory/warehouses/${wh.id}`)
      .send({ code: 'NEW' })
      .expect(400);

    const stock = await ctx
      .api()
      .get(`/inventory/warehouses/${wh.id}/stock`)
      .expect(200);
    const rows = body<{ data: { onHand: number; variant: { sku: string } }[] }>(
      stock,
    ).data;
    expect(rows.map((r) => [r.onHand, r.variant.sku])).toEqual([
      [5, variant.sku],
    ]);
  });

  it('deactivating re-syncs storefront stock', async () => {
    const wh = body<One<Wh>>(
      await ctx
        .api()
        .post('/inventory/warehouses')
        .send({ code: `E2E-${RUN}-B`, name: `E2E ${RUN} B` })
        .expect(201),
    ).data;
    const variant = await createVariant(ctx.prisma, RUN, 'B1');
    await stockIn(ctx.prisma, ctx.inventory, variant.id, wh.id, 7);
    const stockOf = async () =>
      (
        await ctx.prisma.productVariant.findUniqueOrThrow({
          where: { id: variant.id },
        })
      ).stock;
    expect(await stockOf()).toBe(7);

    await ctx
      .api()
      .patch(`/inventory/warehouses/${wh.id}`)
      .send({ isActive: false })
      .expect(200);
    expect(await stockOf()).toBe(0);
    await ctx
      .api()
      .patch(`/inventory/warehouses/${wh.id}`)
      .send({ isActive: true })
      .expect(200);
    expect(await stockOf()).toBe(7);
    expect((await levelOf(ctx.prisma, variant.id, wh.id)).onHand).toBe(7);
  });

  it('deletes only unused warehouses', async () => {
    const used = body<One<Wh>>(
      await ctx
        .api()
        .post('/inventory/warehouses')
        .send({ code: `E2E-${RUN}-C`, name: `E2E ${RUN} C` })
        .expect(201),
    ).data;
    const variant = await createVariant(ctx.prisma, RUN, 'C1');
    await stockIn(ctx.prisma, ctx.inventory, variant.id, used.id, 1);
    await ctx.api().delete(`/inventory/warehouses/${used.id}`).expect(409);

    const empty = body<One<Wh>>(
      await ctx
        .api()
        .post('/inventory/warehouses')
        .send({ code: `E2E-${RUN}-D`, name: `E2E ${RUN} D` })
        .expect(201),
    ).data;
    await ctx.api().delete(`/inventory/warehouses/${empty.id}`).expect(200);
    await ctx.api().get(`/inventory/warehouses/${empty.id}`).expect(404);
  });

  it('rejects a duplicate code and a non-uuid id', async () => {
    await ctx
      .api()
      .post('/inventory/warehouses')
      .send({ code: `E2E-${RUN}-A`, name: `E2E ${RUN} A2` })
      .expect(409);
    await ctx.api().get('/inventory/warehouses/not-a-uuid').expect(400);
  });
});
