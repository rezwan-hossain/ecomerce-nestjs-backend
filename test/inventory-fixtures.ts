/**
 * Shared setup for the inventory workflow e2e specs (see test/test-db.ts).
 * Each spec works in its own warehouses and SKUs, and never touches the
 * default warehouse, so specs can run in parallel.
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { InventoryService } from '../src/modules/inventory/inventory.service';

export const runTag = () => randomUUID().slice(0, 6).toUpperCase();

export const body = <T>(res: request.Response) => res.body as T;

export async function bootApp() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  const app: INestApplication<App> = moduleRef.createNestApplication();
  await app.init();
  return {
    app,
    prisma,
    inventory: app.get(InventoryService),
    api: () => request(app.getHttpServer()),
  };
}

export async function createVariant(
  prisma: PrismaClient,
  run: string,
  suffix: string,
) {
  const product = await prisma.product.create({
    data: {
      name: `E2E ${run} ${suffix}`,
      slug: `e2e-${run}-${suffix}`.toLowerCase(),
    },
  });
  return prisma.productVariant.create({
    data: { productId: product.id, sku: `E2E-${run}-${suffix}`, price: 100 },
  });
}

export function createWarehouse(
  prisma: PrismaClient,
  run: string,
  suffix: string,
) {
  return prisma.warehouse.create({
    data: {
      code: `E2E-${run}-${suffix}`,
      name: `E2E ${run} ${suffix}`,
      type: 'PHYSICAL',
    },
  });
}

/** Books stock straight through the primitive (not under test here). */
export function stockIn(
  prisma: PrismaClient,
  inventory: InventoryService,
  variantId: string,
  warehouseId: string,
  quantity: number,
  unitCost = 10,
) {
  return prisma.$transaction((tx) =>
    inventory.applyMovement(tx, {
      variantId,
      warehouseId,
      type: 'PURCHASE_RECEIVED',
      quantity,
      unitCost,
    }),
  );
}

export function levelOf(
  prisma: PrismaClient,
  variantId: string,
  warehouseId: string,
) {
  return prisma.inventoryLevel.findUniqueOrThrow({
    where: { variantId_warehouseId: { variantId, warehouseId } },
  });
}
