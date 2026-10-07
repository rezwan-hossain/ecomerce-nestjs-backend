# Inventory Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real backends for the admin's Warehouses, Purchase orders, Adjustments and Transfers pages, plus a stock revalue endpoint, API docs and a frontend hookup prompt.

**Architecture:** One service + controller + Zod DTO file per workflow inside `src/modules/inventory/`. Workflow services own document state (lock row → check status → write) and call the existing `InventoryService` primitives (`applyMovement`, `receiveStock`, `applyAdjustment`, `ensureLevel`, …) for every stock change, so the ledger, racks, batches, weighted-average cost and storefront stock stay in one place. Shared helpers (document numbers, row locks, display selects) live in `src/modules/inventory/documents.util.ts`.

**Tech Stack:** NestJS 11, Prisma 7 (`@prisma/adapter-pg`, client in `src/generated/prisma`), Zod 4 via `nestjs-zod`, Jest 30 (unit: mocked Prisma; e2e: supertest against the `_test` database).

**Spec:** `docs/superpowers/specs/2026-10-07-inventory-workflows-design.md`

## Global Constraints

- No auth module and no role checks. ADMIN+ routes are marked with a route comment only. `?actedBy=<userId>` is optional, only recorded, null when missing.
- New endpoints return `{ data }` for one record and `{ data, meta: { total, page, limit, totalPages } }` for lists.
- Existing routes keep their paths and response shapes (spec section "Must keep working"); floor-plan endpoints keep no `{ data }` wrapper.
- Every `:id` param uses `ParseUUIDPipe`; static segments (`bulk`, `requests`) are declared before `:id`.
- A wrong status transition → 409 (`ConflictException`) after `SELECT … FOR UPDATE` on the document row.
- Workflow ledger rows set `referenceType` (`PURCHASE_ORDER` / `TRANSFER` / `ADJUSTMENT`), `referenceId` = document id, and `note` starting with the document number.
- Document numbers: `PO-YYYY-NNNNN`, `TRF-YYYY-NNNNN`, `ADJ-YYYY-NNNNN`, per-kind advisory lock.
- `InventoryLevel.incoming` = outstanding units of submitted POs + shipped transfers for that level.
- Only migration: add `REVALUATION` to `MovementType`. After any `.prisma` edit run `npx prisma generate`; the `src/generated/prisma/**` diff is expected and committed.
- E2E tests must not change the default warehouse (files run in parallel against one database); always pass explicit `warehouseId`s.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Receiving a PO line whose supplier was deactivated after submit** — `receiveStock` rejects inactive suppliers, so receive returns 400 with the supplier name; expected, but must not half-apply (one transaction). Test in Task 4 (`receive is all or nothing`).
2. **Receive/ship request naming the same line twice** — the DTO refuses duplicate `itemId`s (400), so two halves can't bypass the outstanding check. Tests in Task 4 and Task 6 DTO specs.
3. **Approving after stock moved** — a whole-warehouse cycle count applied later lands on the counted number, not the stale delta. Test in Task 2 and the Task 5 e2e.
4. **`GET /inventory/adjustments/bulk`** — must be a 400 from `ParseUUIDPipe`, never a lookup, and `POST /inventory/adjustments` must still be the direct adjustment. Task 5 e2e.
5. **Deactivating a sellable warehouse** — storefront `ProductVariant.stock` drops by that warehouse's available units and comes back on reactivation. Task 3 e2e.

---

## File Map

| File | Responsibility |
|---|---|
| `src/modules/inventory/documents.util.ts` (create) | `nextDocumentNumber`, `lockDocument`, `assertStatus`, `runDocumentTx`, `pageMeta`, display selects + mappers (`VARIANT_LINE_SELECT`/`toVariantLine`, `USER_REF_SELECT`/`toUserRef`, `WAREHOUSE_REF_SELECT`) |
| `src/modules/inventory/documents.util.spec.ts` (create) | unit tests for the above |
| `src/modules/inventory/inventory.service.ts` (modify) | `receiveStock` references, `applyAdjustment` options + whole-warehouse re-base, `changeIncoming`, `revalue`, `nextAdjustmentNumber` delegates, export `SELLABLE_WAREHOUSE_TYPES`, `MOVEMENT_DIRECTION.REVALUATION` |
| `src/modules/inventory/dto/inventory.dto.ts` (modify) | export `pagination`, `isoDateOrDateTime`; `REVALUATION` in `movementTypeEnum`; `RevalueDto` |
| `src/modules/inventory/inventory.controller.ts` (modify) | `POST levels/:levelId/revalue` |
| `src/modules/inventory/warehouses.{service,controller,service.spec}.ts`, `dto/warehouse.dto.ts` (create) | Warehouses |
| `src/modules/inventory/purchase-orders.{service,controller,service.spec}.ts`, `dto/purchase-order.dto.ts` (create) | Purchase orders |
| `src/modules/inventory/stock-adjustments.{service,controller,service.spec}.ts`, `dto/stock-adjustment.dto.ts` (create) | Adjustment documents |
| `src/modules/inventory/transfers.{service,controller,service.spec}.ts`, `dto/transfer.dto.ts` (create) | Transfers |
| `src/modules/inventory/inventory.module.ts` (modify) | register the new controllers/services |
| `prisma/inventory.prisma`, `prisma/migrations/20261007120000_revaluation_movement/migration.sql` | `REVALUATION` |
| `test/inventory-fixtures.ts` (create) | shared e2e boot + fixtures |
| `test/{warehouses,purchase-orders,stock-adjustments,transfers,revalue}.e2e-spec.ts` (create) | e2e per workflow |
| `docs/api/inventory-workflows.md` (create) | API reference |
| `docs/frontend/inventory-workflows-prompt.md` (create) | frontend hookup prompt |

Running e2e needs PostgreSQL up (`sudo systemctl start postgresql`) and `DATABASE_URL` in `.env`; `npm run test:e2e` creates/migrates `<db>_test`.

---

### Task 1: Shared document helpers

**Files:**
- Create: `src/modules/inventory/documents.util.ts`
- Create: `src/modules/inventory/documents.util.spec.ts`
- Modify: `src/modules/inventory/inventory.service.ts` (`nextAdjustmentNumber`, ~line 814)
- Modify: `src/modules/inventory/dto/inventory.dto.ts` (export `pagination`, `isoDateOrDateTime`)

**Interfaces:**
- Produces:
  - `type DocumentKind = 'PO' | 'TRF' | 'ADJ'`
  - `nextDocumentNumber(tx: Prisma.TransactionClient, kind: DocumentKind, date?: Date): Promise<string>`
  - `type DocumentTable = 'purchase_orders' | 'inventory_transfers' | 'stock_adjustments'`
  - `lockDocument(tx, table: DocumentTable, id: string): Promise<boolean>` (false = not found)
  - `assertStatus<S extends string>(doc: { status: S }, allowed: readonly S[], label: string, action: string): void` → `ConflictException("<label> is <STATUS> and can't be <action>")`
  - `runDocumentTx<T>(prisma: PrismaService, fn: (tx) => Promise<T>): Promise<T>` (P2003 → 400 "Referenced record not found", 20 s timeout)
  - `pageMeta(total, page, limit)`
  - `VARIANT_LINE_SELECT`, `toVariantLine(row): VariantLine` where `VariantLine = { id; sku; productName; label }`
  - `USER_REF_SELECT`, `toUserRef(row | null): { id; name } | null`
  - `WAREHOUSE_REF_SELECT` (`{ id, code, name }`)
  - `inventory.dto.ts` exports `pagination` and `isoDateOrDateTime`

- [ ] **Step 1: Write the failing tests**

```ts
// src/modules/inventory/documents.util.spec.ts
import { ConflictException } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma/client';
import {
  assertStatus,
  lockDocument,
  nextDocumentNumber,
  pageMeta,
  toUserRef,
  toVariantLine,
} from './documents.util';

function mockTx() {
  return {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    purchaseOrder: { findFirst: jest.fn() },
    inventoryTransfer: { findFirst: jest.fn() },
    stockAdjustment: { findFirst: jest.fn() },
  };
}
const asTx = (t: ReturnType<typeof mockTx>) =>
  t as unknown as Prisma.TransactionClient;

describe('nextDocumentNumber', () => {
  it('starts each year at 00001', async () => {
    const tx = mockTx();
    tx.purchaseOrder.findFirst.mockResolvedValue(null);
    await expect(
      nextDocumentNumber(asTx(tx), 'PO', new Date('2026-03-01')),
    ).resolves.toBe('PO-2026-00001');
    expect(tx.$executeRaw).toHaveBeenCalled(); // advisory lock taken
  });

  it('continues after the last number of the year', async () => {
    const tx = mockTx();
    tx.inventoryTransfer.findFirst.mockResolvedValue({
      transferNumber: 'TRF-2026-00041',
    });
    await expect(
      nextDocumentNumber(asTx(tx), 'TRF', new Date('2026-10-07')),
    ).resolves.toBe('TRF-2026-00042');
  });

  it('numbers adjustments from stockAdjustment', async () => {
    const tx = mockTx();
    tx.stockAdjustment.findFirst.mockResolvedValue({
      adjustmentNumber: 'ADJ-2026-00009',
    });
    await expect(
      nextDocumentNumber(asTx(tx), 'ADJ', new Date('2026-10-07')),
    ).resolves.toBe('ADJ-2026-00010');
  });
});

describe('lockDocument', () => {
  it('reports whether the row exists', async () => {
    const tx = mockTx();
    tx.$queryRaw.mockResolvedValueOnce([{ id: 'po-1' }]).mockResolvedValueOnce([]);
    await expect(lockDocument(asTx(tx), 'purchase_orders', 'po-1')).resolves.toBe(true);
    await expect(lockDocument(asTx(tx), 'purchase_orders', 'po-2')).resolves.toBe(false);
  });
});

describe('assertStatus', () => {
  it('passes an allowed status', () => {
    expect(() =>
      assertStatus({ status: 'DRAFT' }, ['DRAFT'], 'PO-2026-00001', 'edited'),
    ).not.toThrow();
  });

  it('throws 409 naming the document and its status', () => {
    expect(() =>
      assertStatus({ status: 'RECEIVED' }, ['DRAFT'], 'PO-2026-00001', 'edited'),
    ).toThrow(
      new ConflictException("PO-2026-00001 is RECEIVED and can't be edited"),
    );
  });
});

describe('toVariantLine', () => {
  it('labels option values sorted by option name', () => {
    expect(
      toVariantLine({
        id: 'v1',
        sku: 'TEE-RED-XL',
        product: { name: 'Tee' },
        optionValues: [
          { optionValue: { value: 'XL', option: { name: 'Size' } } },
          { optionValue: { value: 'Red', option: { name: 'Color' } } },
        ],
      }),
    ).toEqual({ id: 'v1', sku: 'TEE-RED-XL', productName: 'Tee', label: 'Red / XL' });
  });
});

describe('toUserRef', () => {
  const base = { id: 'u1', firstName: null, lastName: null, userName: null, email: 'a@b.c' };
  it('prefers the full name, then userName, then email', () => {
    expect(toUserRef({ ...base, firstName: 'Nusrat', lastName: 'Jahan' })).toEqual({ id: 'u1', name: 'Nusrat Jahan' });
    expect(toUserRef({ ...base, userName: 'nusrat' })).toEqual({ id: 'u1', name: 'nusrat' });
    expect(toUserRef(base)).toEqual({ id: 'u1', name: 'a@b.c' });
    expect(toUserRef(null)).toBeNull();
  });
});

describe('pageMeta', () => {
  it('never reports zero pages', () => {
    expect(pageMeta(0, 1, 20)).toEqual({ total: 0, page: 1, limit: 20, totalPages: 1 });
    expect(pageMeta(41, 2, 20)).toEqual({ total: 41, page: 2, limit: 20, totalPages: 3 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/inventory/documents.util.spec.ts`
Expected: FAIL — `Cannot find module './documents.util'`.

- [ ] **Step 3: Implement `documents.util.ts`**

```ts
// src/modules/inventory/documents.util.ts
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { Prisma } from 'src/generated/prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

/* Helpers shared by the inventory document workflows (purchase orders,
   transfers, stock adjustments). */

export type DocumentKind = 'PO' | 'TRF' | 'ADJ';

// The ADJ key matches what nextAdjustmentNumber always locked on.
const NUMBER_LOCK_KEY: Record<DocumentKind, string> = {
  PO: 'purchase_orders.poNumber',
  TRF: 'inventory_transfers.transferNumber',
  ADJ: 'stock_adjustments.adjustmentNumber',
};

const LAST_NUMBER: Record<
  DocumentKind,
  (tx: Prisma.TransactionClient, prefix: string) => Promise<string | null>
> = {
  PO: async (tx, prefix) =>
    (
      await tx.purchaseOrder.findFirst({
        where: { poNumber: { startsWith: prefix } },
        orderBy: { poNumber: 'desc' },
        select: { poNumber: true },
      })
    )?.poNumber ?? null,
  TRF: async (tx, prefix) =>
    (
      await tx.inventoryTransfer.findFirst({
        where: { transferNumber: { startsWith: prefix } },
        orderBy: { transferNumber: 'desc' },
        select: { transferNumber: true },
      })
    )?.transferNumber ?? null,
  ADJ: async (tx, prefix) =>
    (
      await tx.stockAdjustment.findFirst({
        where: { adjustmentNumber: { startsWith: prefix } },
        orderBy: { adjustmentNumber: 'desc' },
        select: { adjustmentNumber: true },
      })
    )?.adjustmentNumber ?? null,
};

/** "PO-2026-00042": next number for the year, serialised by an advisory lock. */
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  kind: DocumentKind,
  date = new Date(),
): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${NUMBER_LOCK_KEY[kind]}::text))`;
  const prefix = `${kind}-${date.getFullYear()}-`;
  const last = await LAST_NUMBER[kind](tx, prefix);
  const n = last ? Number(last.slice(prefix.length)) : 0;
  return `${prefix}${String((Number.isFinite(n) ? n : 0) + 1).padStart(5, '0')}`;
}

export type DocumentTable =
  | 'purchase_orders'
  | 'inventory_transfers'
  | 'stock_adjustments';

/** Locks a document row for the rest of the transaction; false if missing. */
export async function lockDocument(
  tx: Prisma.TransactionClient,
  table: DocumentTable,
  id: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id} FOR UPDATE`,
  );
  return rows.length > 0;
}

/** 409 unless the document is in one of the allowed statuses. */
export function assertStatus<S extends string>(
  doc: { status: S },
  allowed: readonly S[],
  label: string,
  action: string,
): void {
  if (!allowed.includes(doc.status)) {
    throw new ConflictException(
      `${label} is ${doc.status} and can't be ${action}`,
    );
  }
}

/** A document transaction: long enough for 200-line receipts. */
export async function runDocumentTx<T>(
  prisma: PrismaService,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(fn, { timeout: 20_000 });
  } catch (e) {
    // FK failure: actedBy / a referenced row doesn't exist.
    if (e instanceof PrismaClientKnownRequestError && e.code === 'P2003') {
      throw new BadRequestException('Referenced record not found');
    }
    throw e;
  }
}

export function pageMeta(total: number, page: number, limit: number) {
  return { total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

// ─── Display shapes for document lines ───────────

export const VARIANT_LINE_SELECT = {
  id: true,
  sku: true,
  product: { select: { name: true } },
  optionValues: {
    select: {
      optionValue: {
        select: { value: true, option: { select: { name: true } } },
      },
    },
  },
} satisfies Prisma.ProductVariantSelect;

export type VariantLineRow = Prisma.ProductVariantGetPayload<{
  select: typeof VARIANT_LINE_SELECT;
}>;

export interface VariantLine {
  id: string;
  sku: string;
  productName: string;
  label: string; // "Red / XL"; empty for a variant without options
}

export function toVariantLine(v: VariantLineRow): VariantLine {
  // Sorted by option name so the label is stable, as in InventoryService.
  const label = [...v.optionValues]
    .sort((a, b) =>
      a.optionValue.option.name.localeCompare(b.optionValue.option.name),
    )
    .map((ov) => ov.optionValue.value)
    .join(' / ');
  return { id: v.id, sku: v.sku, productName: v.product.name, label };
}

export const USER_REF_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  userName: true,
  email: true,
} satisfies Prisma.UserSelect;

export type UserRefRow = Prisma.UserGetPayload<{
  select: typeof USER_REF_SELECT;
}>;

export function toUserRef(u: UserRefRow | null) {
  if (!u) return null;
  const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ');
  return { id: u.id, name: fullName || u.userName || u.email };
}

export const WAREHOUSE_REF_SELECT = {
  id: true,
  code: true,
  name: true,
} satisfies Prisma.WarehouseSelect;
```

- [ ] **Step 4: Delegate `nextAdjustmentNumber` and export DTO helpers**

In `inventory.service.ts` replace the body of `nextAdjustmentNumber` (keep the method; `countLocation` calls it):

```ts
  /** "ADJ-2026-00042": next number for the year, serialised by a lock. */
  async nextAdjustmentNumber(
    tx: Prisma.TransactionClient,
    date = new Date(),
  ): Promise<string> {
    return nextDocumentNumber(tx, 'ADJ', date);
  }
```

and add `import { nextDocumentNumber } from './documents.util';` to its imports.

In `dto/inventory.dto.ts` change `const pagination = {` to `export const pagination = {` and `const isoDateOrDateTime = z.union([` to `export const isoDateOrDateTime = z.union([`.

- [ ] **Step 5: Run the tests**

Run: `npx jest src/modules/inventory`
Expected: PASS (new spec and the existing `inventory.service.spec.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/modules/inventory/documents.util.ts src/modules/inventory/documents.util.spec.ts src/modules/inventory/inventory.service.ts src/modules/inventory/dto/inventory.dto.ts
git commit -m "feat(inventory): shared helpers for inventory documents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: InventoryService extensions

**Files:**
- Modify: `src/modules/inventory/inventory.service.ts` (`StockReceipt` ~line 64, `receiveStock` ~457, `applyAdjustment` ~716, new `changeIncoming` after `ensureLevel` ~1092, `SELLABLE_WAREHOUSE_TYPES` ~143)
- Test: `src/modules/inventory/inventory.service.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `StockReceipt` gains `purchaseOrderItemId?: string | null; referenceType?: ReferenceType | null; referenceId?: string | null`
  - `applyAdjustment(tx, adjustmentId: string, userId?: string | null, opts?: { requireStatus?: AdjustmentStatus })`
  - `changeIncoming(tx, variantId: string, warehouseId: string, delta: number): Promise<void>`
  - `export const SELLABLE_WAREHOUSE_TYPES` (was module-private)

- [ ] **Step 1: Extend the mock and write failing tests**

In `createMockPrisma()` in `inventory.service.spec.ts`, extend `tx`:

```ts
    inventoryLevel: {
      upsert: jest.fn().mockResolvedValue({ id: 'level-1' }),
      update: jest.fn((args: { data: object }) => args.data),
      findUnique: jest.fn(),
    },
    stockAdjustment: {
      findUnique: jest.fn(),
      update: jest.fn((args: { data: object }) => args.data),
    },
    stockAdjustmentItem: { update: jest.fn() },
```

Add these tests at the end of the `describe('InventoryService')` block:

```ts
  // ═════════════════════════════════════════════════
  //   receiveStock — document references
  // ═════════════════════════════════════════════════

  describe('receiveStock references', () => {
    it('links the batch and movement to a purchase order line', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 0 })]);

      const [movement] = await service.receiveStock(asTx(), {
        variantId: VARIANT,
        quantity: 5,
        unitCost: 50,
        supplierId: 'sup-1',
        purchaseOrderItemId: 'poi-1',
        referenceType: 'PURCHASE_ORDER',
        referenceId: 'po-1',
        note: 'PO-2026-00001',
      });

      expect(
        callArg<{ data: { purchaseOrderItemId: string } }>(tx.inventoryBatch.create).data,
      ).toMatchObject({ purchaseOrderItemId: 'poi-1' });
      expect(movement).toMatchObject({
        referenceType: 'PURCHASE_ORDER',
        referenceId: 'po-1',
        note: 'PO-2026-00001',
      });
      expect(movement.unitCost?.toString()).toBe('50');
    });

    it('keeps the products opening-stock path unchanged', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 0 })]);

      const movements = await service.recordInitialStock(
        asTx(),
        { id: VARIANT, stock: 20 },
        { unitCost: 450, supplierId: 'sup-1', userId: 'admin-1' },
      );

      expect(
        callArg<{ data: object }>(tx.inventoryBatch.create).data,
      ).toMatchObject({
        variantId: VARIANT,
        warehouseId: WAREHOUSE,
        quantity: 20,
        initialQty: 20,
        supplierId: 'sup-1',
        purchaseOrderItemId: null,
        note: null,
      });
      expect(movements).toEqual([
        expect.objectContaining({
          type: 'PURCHASE_RECEIVED',
          quantity: 20,
          referenceType: null,
          referenceId: null,
          note: 'Opening stock',
          performedByUserId: 'admin-1',
          batchId: 'batch-1',
        }),
      ]);
    });
  });

  // ═════════════════════════════════════════════════
  //   applyAdjustment
  // ═════════════════════════════════════════════════

  describe('applyAdjustment', () => {
    const adjustment = (overrides: object = {}) => ({
      id: 'adj-1',
      adjustmentNumber: 'ADJ-2026-00001',
      type: 'CYCLE_COUNT',
      status: 'APPROVED',
      note: null,
      approvedByUserId: null,
      approvedAt: null,
      items: [
        {
          id: 'item-1',
          variantId: VARIANT,
          warehouseId: WAREHOUSE,
          locationId: null,
          expectedQty: 10,
          actualQty: 8,
          adjustmentQty: -2,
          unitCost: new Decimal(0),
        },
      ],
      ...overrides,
    });

    it('refuses a status other than requireStatus', async () => {
      tx.$queryRaw.mockResolvedValue([]);
      tx.stockAdjustment.findUnique.mockResolvedValue(
        adjustment({ status: 'PENDING' }),
      );

      await expect(
        service.applyAdjustment(asTx(), 'adj-1', null, { requireStatus: 'APPROVED' }),
      ).rejects.toThrow(ConflictException);
      expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    });

    it('still applies PENDING without options (rack-map applyNow)', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 10 })]);
      tx.stockAdjustment.findUnique.mockResolvedValue(
        adjustment({ status: 'PENDING' }),
      );
      tx.inventoryLevel.findUnique.mockResolvedValue({ onHand: 10 });
      tx.locationStock.findMany.mockResolvedValue([rack('a-01', 10)]);

      await expect(service.applyAdjustment(asTx(), 'adj-1')).resolves.toMatchObject({
        status: 'APPLIED',
      });
    });

    it('re-bases a whole-warehouse count on the current onHand', async () => {
      // Counted 8 when the system said 10; 2 more arrived since → 12 now.
      tx.$queryRaw.mockResolvedValue([level({ onHand: 12 })]);
      tx.stockAdjustment.findUnique.mockResolvedValue(adjustment());
      tx.inventoryLevel.findUnique.mockResolvedValue({ onHand: 12 });
      tx.locationStock.findMany.mockResolvedValue([rack('a-01', 12)]);

      await service.applyAdjustment(asTx(), 'adj-1', 'admin-1', {
        requireStatus: 'APPROVED',
      });

      expect(
        callArg<{ data: object }>(tx.stockAdjustmentItem.update).data,
      ).toEqual({ expectedQty: 12, adjustmentQty: -4 });
      expect(
        callArg<{ data: object }>(tx.inventoryMovement.create).data,
      ).toMatchObject({
        type: 'ADJUSTMENT_DECREASE',
        quantity: 4,
        referenceType: 'ADJUSTMENT',
        referenceId: 'adj-1',
        note: 'ADJ-2026-00001',
      });
    });
  });

  // ═════════════════════════════════════════════════
  //   changeIncoming
  // ═════════════════════════════════════════════════

  describe('changeIncoming', () => {
    it('increments incoming on the (created) level', async () => {
      await service.changeIncoming(asTx(), VARIANT, WAREHOUSE, -3);
      expect(tx.inventoryLevel.upsert).toHaveBeenCalled();
      expect(callArg<{ data: object }>(tx.inventoryLevel.update).data).toEqual({
        incoming: { increment: -3 },
        version: { increment: 1 },
      });
    });

    it('does nothing for a zero delta', async () => {
      await service.changeIncoming(asTx(), VARIANT, WAREHOUSE, 0);
      expect(tx.inventoryLevel.update).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/modules/inventory/inventory.service.spec.ts`
Expected: FAIL — type errors on `purchaseOrderItemId` / 4th `applyAdjustment` arg / `changeIncoming` missing.

- [ ] **Step 3: Implement**

`StockReceipt` — add after `userId?: string | null;`:

```ts
  // Purchase-order receiving: links the batch to the PO line and the
  // movement to the PO. Omitted (opening stock, /receive): both stay null.
  purchaseOrderItemId?: string | null;
  referenceType?: ReferenceType | null;
  referenceId?: string | null;
```

In `receiveStock`, `inventoryBatch.create` data — add after `supplierId: receipt.supplierId ?? null,`:

```ts
        purchaseOrderItemId: receipt.purchaseOrderItemId ?? null,
```

and in its `applyMovement` call add after `batchId: batch.id,`:

```ts
      referenceType: receipt.referenceType,
      referenceId: receipt.referenceId,
```

`applyAdjustment` — new signature and status check, and re-base for both cycle-count kinds (replace from the signature to the `if (delta === 0) continue;` line):

```ts
  async applyAdjustment(
    tx: Prisma.TransactionClient,
    adjustmentId: string,
    userId?: string | null,
    opts: { requireStatus?: AdjustmentStatus } = {},
  ) {
    // Serialises appliers of the same adjustment.
    await tx.$queryRaw`
      SELECT "id" FROM "stock_adjustments" WHERE "id" = ${adjustmentId} FOR UPDATE`;
    const adjustment = await tx.stockAdjustment.findUnique({
      where: { id: adjustmentId },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    if (!adjustment) throw new NotFoundException('Adjustment not found');
    const allowed: AdjustmentStatus[] = opts.requireStatus
      ? [opts.requireStatus]
      : ['PENDING', 'APPROVED'];
    if (!allowed.includes(adjustment.status)) {
      throw new ConflictException(
        `${adjustment.adjustmentNumber} is ${adjustment.status} and can't be applied`,
      );
    }

    for (const item of adjustment.items) {
      let delta = item.adjustmentQty;
      // A count lands on the counted number even if stock moved since:
      // re-base on what the rack (or the whole warehouse) holds now.
      if (adjustment.type === 'CYCLE_COUNT' && item.actualQty !== null) {
        const expected = item.locationId
          ? await this.locationQuantity(tx, item.variantId, item.warehouseId, item.locationId)
          : ((
              await tx.inventoryLevel.findUnique({
                where: {
                  variantId_warehouseId: {
                    variantId: item.variantId,
                    warehouseId: item.warehouseId,
                  },
                },
                select: { onHand: true },
              })
            )?.onHand ?? 0);
        delta = item.actualQty - expected;
        if (delta !== item.adjustmentQty || expected !== item.expectedQty) {
          await tx.stockAdjustmentItem.update({
            where: { id: item.id },
            data: { expectedQty: expected, adjustmentQty: delta },
          });
        }
      }
      if (delta === 0) continue;
```

(the rest of the loop and the final `stockAdjustment.update` stay as they are). Add the private helper next to the other rack helpers (it is the code that was inline before):

```ts
  /** Units of a variant on one location (0 when none). */
  private async locationQuantity(
    tx: Prisma.TransactionClient,
    variantId: string,
    warehouseId: string,
    locationId: string,
  ): Promise<number> {
    const level = await this.ensureLevel(tx, variantId, warehouseId);
    const row = await tx.locationStock.findUnique({
      where: {
        inventoryLevelId_locationId: { inventoryLevelId: level.id, locationId },
      },
      select: { quantity: true },
    });
    return row?.quantity ?? 0;
  }
```

Add `AdjustmentStatus` to the `import type { … } from 'src/generated/prisma/enums'` list.

`changeIncoming` — add after `ensureLevel`:

```ts
  /**
   * Units expected at a level from submitted purchase orders and shipped
   * transfers. Negative delta removes them; the DB CHECK keeps it >= 0.
   */
  async changeIncoming(
    tx: Prisma.TransactionClient,
    variantId: string,
    warehouseId: string,
    delta: number,
  ): Promise<void> {
    if (delta === 0) return;
    const level = await this.ensureLevel(tx, variantId, warehouseId);
    await tx.inventoryLevel.update({
      where: { id: level.id },
      data: { incoming: { increment: delta }, version: { increment: 1 } },
    });
  }
```

Change `const SELLABLE_WAREHOUSE_TYPES = ['PHYSICAL', 'STORE'] as const;` to `export const SELLABLE_WAREHOUSE_TYPES = …`.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/inventory`
Expected: PASS, including every pre-existing test (the location re-base behaviour is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/modules/inventory/inventory.service.ts src/modules/inventory/inventory.service.spec.ts
git commit -m "feat(inventory): receipts carry document references, adjustments re-base whole-warehouse counts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Warehouses API

**Files:**
- Create: `src/modules/inventory/dto/warehouse.dto.ts`
- Create: `src/modules/inventory/warehouses.service.ts`
- Create: `src/modules/inventory/warehouses.controller.ts`
- Create: `src/modules/inventory/warehouses.service.spec.ts`
- Modify: `src/modules/inventory/inventory.module.ts`
- Create: `test/inventory-fixtures.ts`
- Create: `test/warehouses.e2e-spec.ts`

**Interfaces:**
- Consumes: `InventoryService.getUnassignedLocationId(tx, warehouseId)`, `InventoryService.syncVariantStock(tx, variantId)`, `SELLABLE_WAREHOUSE_TYPES`, `UNASSIGNED_LOCATION_CODE`; Task 1 helpers.
- Produces: routes under `/inventory/warehouses`; `test/inventory-fixtures.ts` exports `bootApp()`, `runTag()`, `createVariant()`, `createWarehouse()`, `stockIn()`, `levelOf()`, `body<T>()` (used by every later e2e).

- [ ] **Step 1: DTOs**

```ts
// src/modules/inventory/dto/warehouse.dto.ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { pagination } from './inventory.dto';

/* ==========================================
   WAREHOUSE SCHEMAS & DTOS
   ========================================== */

export const warehouseTypeEnum = z.enum([
  'PHYSICAL',
  'STORE',
  'VIRTUAL_DAMAGE',
  'VIRTUAL_QC',
  'VIRTUAL_RETURN',
]);

const nullableText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

const editable = {
  name: z.string().trim().min(2).max(100).meta({ example: 'Dhaka Main' }),
  type: warehouseTypeEnum,
  addressLine1: nullableText(255),
  addressLine2: nullableText(255),
  city: nullableText(100),
  state: nullableText(100), // division
  postalCode: nullableText(20),
  priority: z.number().int().min(0).max(1000), // reserved from first when higher
  isDefault: z.boolean(),
  isActive: z.boolean(),
};

export const createWarehouseSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(20)
    .regex(/^[A-Z0-9-]+$/, {
      message: 'Code must contain only uppercase letters, digits and hyphens',
    })
    .meta({ example: 'DHK-01' }),
  ...editable,
  type: editable.type.default('PHYSICAL'),
  priority: editable.priority.default(0),
  isDefault: editable.isDefault.default(false),
  isActive: editable.isActive.default(true),
});

export class CreateWarehouseDto extends createZodDto(createWarehouseSchema) {}

export const updateWarehouseSchema = z.object({
  // Racks and documents show the code, so it's fixed after create.
  code: z
    .never({ error: "code can't be changed after the warehouse is created" })
    .optional(),
  name: editable.name.optional(),
  type: editable.type.optional(),
  addressLine1: editable.addressLine1,
  addressLine2: editable.addressLine2,
  city: editable.city,
  state: editable.state,
  postalCode: editable.postalCode,
  priority: editable.priority.optional(),
  isDefault: editable.isDefault.optional(),
  isActive: editable.isActive.optional(),
});

export class UpdateWarehouseDto extends createZodDto(updateWarehouseSchema) {}

export const warehouseStockQuerySchema = z.object({
  ...pagination,
  search: z.string().trim().min(1).optional(), // SKU or product name
});

export class WarehouseStockQueryDto extends createZodDto(
  warehouseStockQuerySchema,
) {}
```

- [ ] **Step 2: Write the failing unit tests**

```ts
// src/modules/inventory/warehouses.service.spec.ts
import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { WarehousesService } from './warehouses.service';

const WH = {
  id: 'wh-1',
  code: 'DHK-01',
  name: 'Dhaka',
  type: 'PHYSICAL',
  isActive: true,
  isDefault: false,
};

function mockDb() {
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'wh-1' }]),
    warehouse: {
      findUnique: jest.fn().mockResolvedValue(WH),
      findMany: jest.fn().mockResolvedValue([WH]),
      create: jest.fn((a: { data: object }) => ({ id: 'wh-new', ...a.data })),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    storageLocation: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), deleteMany: jest.fn() },
    inventoryLevel: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    inventoryMovement: { count: jest.fn().mockResolvedValue(0) },
    inventoryBatch: { count: jest.fn().mockResolvedValue(0) },
    purchaseOrder: { count: jest.fn().mockResolvedValue(0) },
    purchaseOrderItem: { count: jest.fn().mockResolvedValue(0) },
    inventoryTransfer: { count: jest.fn().mockResolvedValue(0) },
    stockAdjustmentItem: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((fn: (t: typeof db) => unknown) => fn(db));
  return db;
}

describe('WarehousesService', () => {
  let service: WarehousesService;
  let db: ReturnType<typeof mockDb>;
  const inventory = {
    getUnassignedLocationId: jest.fn(),
    syncVariantStock: jest.fn(),
  };

  beforeEach(async () => {
    db = mockDb();
    const moduleRef = await Test.createTestingModule({
      providers: [
        WarehousesService,
        { provide: PrismaService, useValue: db },
        { provide: InventoryService, useValue: inventory },
      ],
    }).compile();
    service = moduleRef.get(WarehousesService);
  });

  afterEach(() => jest.clearAllMocks());

  const base = {
    code: 'CTG-01',
    name: 'Chattogram',
    type: 'PHYSICAL' as const,
    priority: 0,
    isActive: true,
  };

  describe('create', () => {
    it('makes it the only default and opens its UNASSIGNED location', async () => {
      await service.create({ ...base, isDefault: true });
      expect(db.warehouse.updateMany).toHaveBeenCalledWith({
        where: { isDefault: true },
        data: { isDefault: false },
      });
      expect(inventory.getUnassignedLocationId).toHaveBeenCalledWith(db, 'wh-new');
    });

    it('refuses an inactive default', async () => {
      await expect(
        service.create({ ...base, isDefault: true, isActive: false }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    it("won't unset the current default", async () => {
      db.warehouse.findUnique.mockResolvedValue({ ...WH, isDefault: true });
      await expect(service.update('wh-1', { isDefault: false })).rejects.toThrow(
        BadRequestException,
      );
    });

    it("won't deactivate the default", async () => {
      db.warehouse.findUnique.mockResolvedValue({ ...WH, isDefault: true });
      await expect(service.update('wh-1', { isActive: false })).rejects.toThrow(
        BadRequestException,
      );
    });

    it("won't deactivate with open documents", async () => {
      db.purchaseOrder.count.mockResolvedValue(1);
      await expect(service.update('wh-1', { isActive: false })).rejects.toThrow(
        ConflictException,
      );
      expect(db.warehouse.update).not.toHaveBeenCalled();
    });

    it('re-syncs storefront stock when it stops being sellable', async () => {
      db.inventoryLevel.findMany.mockResolvedValue([
        { variantId: 'v1' },
        { variantId: 'v2' },
      ]);
      await service.update('wh-1', { type: 'VIRTUAL_DAMAGE' });
      expect(inventory.syncVariantStock).toHaveBeenCalledTimes(2);
    });

    it("doesn't re-sync when sellability is unchanged", async () => {
      await service.update('wh-1', { name: 'Dhaka Central', type: 'STORE' });
      expect(inventory.syncVariantStock).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it("won't delete the default", async () => {
      db.warehouse.findUnique.mockResolvedValue({ ...WH, isDefault: true });
      await expect(service.remove('wh-1')).rejects.toThrow(ConflictException);
    });

    it('refuses a warehouse with stock or history', async () => {
      db.inventoryLevel.count.mockResolvedValue(3);
      await expect(service.remove('wh-1')).rejects.toThrow(ConflictException);
      expect(db.warehouse.delete).not.toHaveBeenCalled();
    });

    it('deletes an unused warehouse with its UNASSIGNED location', async () => {
      await expect(service.remove('wh-1')).resolves.toEqual({
        data: { id: 'wh-1', result: 'deleted' },
      });
      expect(db.storageLocation.deleteMany).toHaveBeenCalledWith({
        where: { warehouseId: 'wh-1' },
      });
      expect(db.warehouse.delete).toHaveBeenCalledWith({ where: { id: 'wh-1' } });
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/modules/inventory/warehouses.service.spec.ts`
Expected: FAIL — `Cannot find module './warehouses.service'`.

- [ ] **Step 4: Implement the service**

```ts
// src/modules/inventory/warehouses.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Decimal,
  PrismaClientKnownRequestError,
} from '@prisma/client/runtime/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma/client';
import type { WarehouseType } from 'src/generated/prisma/enums';
import {
  InventoryService,
  SELLABLE_WAREHOUSE_TYPES,
  UNASSIGNED_LOCATION_CODE,
} from './inventory.service';
import {
  pageMeta,
  runDocumentTx,
  toVariantLine,
  VARIANT_LINE_SELECT,
} from './documents.util';
import {
  CreateWarehouseDto,
  UpdateWarehouseDto,
  WarehouseStockQueryDto,
} from './dto/warehouse.dto';

export interface WarehouseCounts {
  locations: number; // excluding UNASSIGNED
  variantsStocked: number; // levels with onHand > 0
  unitsOnHand: number;
  stockValue: Decimal; // Σ totalCost
}

const isSellable = (type: WarehouseType, isActive: boolean) =>
  isActive && (SELLABLE_WAREHOUSE_TYPES as readonly string[]).includes(type);

@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async findAll() {
    const warehouses = await this.prisma.warehouse.findMany({
      orderBy: [{ isDefault: 'desc' }, { priority: 'desc' }, { name: 'asc' }],
    });
    const counts = await this.countsFor(warehouses.map((w) => w.id));
    return {
      data: warehouses.map((w) => ({ ...w, counts: counts.get(w.id)! })),
    };
  }

  async findOne(id: string) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    const counts = await this.countsFor([id]);
    return { data: { ...warehouse, counts: counts.get(id)! } };
  }

  async create(dto: CreateWarehouseDto) {
    if (dto.isDefault && !dto.isActive) {
      throw new BadRequestException("The default warehouse can't be inactive");
    }
    try {
      const warehouse = await runDocumentTx(this.prisma, async (tx) => {
        if (dto.isDefault) {
          await tx.warehouse.updateMany({
            where: { isDefault: true },
            data: { isDefault: false },
          });
        }
        const created = await tx.warehouse.create({ data: dto });
        await this.inventory.getUnassignedLocationId(tx, created.id);
        return created;
      });
      return this.findOne(warehouse.id);
    } catch (e) {
      this.rethrowUnique(e);
    }
  }

  async update(id: string, dto: UpdateWarehouseDto) {
    try {
      await runDocumentTx(this.prisma, async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "warehouses" WHERE "id" = ${id} FOR UPDATE`;
        const current = await tx.warehouse.findUnique({ where: { id } });
        if (!current) throw new NotFoundException('Warehouse not found');

        const isActive = dto.isActive ?? current.isActive;
        const isDefault = dto.isDefault ?? current.isDefault;
        const type = dto.type ?? current.type;
        if (current.isDefault && dto.isDefault === false) {
          throw new BadRequestException(
            'Make another warehouse the default instead',
          );
        }
        if (isDefault && !isActive) {
          throw new BadRequestException(
            "The default warehouse can't be inactive",
          );
        }
        if (current.isActive && !isActive) {
          await this.assertNoOpenDocuments(tx, id);
        }
        if (isDefault && !current.isDefault) {
          await tx.warehouse.updateMany({
            where: { isDefault: true },
            data: { isDefault: false },
          });
        }

        // code is z.never(), so always undefined here.
        await tx.warehouse.update({ where: { id }, data: { ...dto, code: undefined } });

        // Storefront stock only counts active sellable warehouses.
        if (isSellable(current.type, current.isActive) !== isSellable(type, isActive)) {
          const levels = await tx.inventoryLevel.findMany({
            where: { warehouseId: id },
            select: { variantId: true },
          });
          for (const level of levels) {
            await this.inventory.syncVariantStock(tx, level.variantId);
          }
        }
      });
      return this.findOne(id);
    } catch (e) {
      this.rethrowUnique(e);
    }
  }

  async remove(id: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const warehouse = await tx.warehouse.findUnique({
        where: { id },
        select: { isDefault: true },
      });
      if (!warehouse) throw new NotFoundException('Warehouse not found');
      if (warehouse.isDefault) {
        throw new ConflictException("The default warehouse can't be deleted");
      }

      const inUse = await Promise.all([
        tx.inventoryLevel.count({ where: { warehouseId: id } }),
        tx.storageLocation.count({
          where: { warehouseId: id, code: { not: UNASSIGNED_LOCATION_CODE } },
        }),
        tx.inventoryMovement.count({
          where: { OR: [{ sourceWarehouseId: id }, { destWarehouseId: id }] },
        }),
        tx.inventoryBatch.count({ where: { warehouseId: id } }),
        tx.purchaseOrderItem.count({ where: { warehouseId: id } }),
        tx.inventoryTransfer.count({
          where: { OR: [{ fromWarehouseId: id }, { toWarehouseId: id }] },
        }),
        tx.stockAdjustmentItem.count({ where: { warehouseId: id } }),
      ]);
      if (inUse.some((n) => n > 0)) {
        throw new ConflictException(
          'This warehouse has stock, racks or documents. Deactivate it instead.',
        );
      }

      // Only its empty UNASSIGNED location is left.
      await tx.storageLocation.deleteMany({ where: { warehouseId: id } });
      await tx.warehouse.delete({ where: { id } });
    });
    return { data: { id, result: 'deleted' as const } };
  }

  async stock(id: string, query: WarehouseStockQueryDto) {
    const { page, limit, search } = query;
    const exists = await this.prisma.warehouse.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Warehouse not found');

    const where: Prisma.InventoryLevelWhereInput = {
      warehouseId: id,
      ...(search && {
        variant: {
          OR: [
            { sku: { contains: search, mode: 'insensitive' } },
            { product: { name: { contains: search, mode: 'insensitive' } } },
          ],
        },
      }),
    };
    const [total, levels] = await Promise.all([
      this.prisma.inventoryLevel.count({ where }),
      this.prisma.inventoryLevel.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ variant: { sku: 'asc' } }],
        select: {
          id: true,
          onHand: true,
          reserved: true,
          available: true,
          incoming: true,
          damaged: true,
          unitCost: true,
          totalCost: true,
          updatedAt: true,
          variant: { select: VARIANT_LINE_SELECT },
          defaultLocation: { select: { id: true, code: true } },
        },
      }),
    ]);
    return {
      data: levels.map((l) => ({ ...l, variant: toVariantLine(l.variant) })),
      meta: pageMeta(total, page, limit),
    };
  }

  private async countsFor(ids: string[]): Promise<Map<string, WarehouseCounts>> {
    const [locations, stocked, totals] = await Promise.all([
      this.prisma.storageLocation.groupBy({
        by: ['warehouseId'],
        where: { warehouseId: { in: ids }, code: { not: UNASSIGNED_LOCATION_CODE } },
        _count: { _all: true },
      }),
      this.prisma.inventoryLevel.groupBy({
        by: ['warehouseId'],
        where: { warehouseId: { in: ids }, onHand: { gt: 0 } },
        _count: { _all: true },
      }),
      this.prisma.inventoryLevel.groupBy({
        by: ['warehouseId'],
        where: { warehouseId: { in: ids } },
        _sum: { onHand: true, totalCost: true },
      }),
    ]);
    return new Map(
      ids.map((id) => {
        const sum = totals.find((t) => t.warehouseId === id)?._sum;
        return [
          id,
          {
            locations: locations.find((l) => l.warehouseId === id)?._count._all ?? 0,
            variantsStocked: stocked.find((s) => s.warehouseId === id)?._count._all ?? 0,
            unitsOnHand: sum?.onHand ?? 0,
            stockValue: sum?.totalCost ?? new Decimal(0),
          },
        ];
      }),
    );
  }

  private async assertNoOpenDocuments(tx: Prisma.TransactionClient, id: string) {
    const [pos, transfers] = await Promise.all([
      tx.purchaseOrder.count({
        where: {
          status: { in: ['SUBMITTED', 'CONFIRMED', 'PARTIAL'] },
          items: { some: { warehouseId: id } },
        },
      }),
      tx.inventoryTransfer.count({
        where: {
          status: { in: ['PENDING', 'IN_TRANSIT', 'PARTIAL'] },
          OR: [{ fromWarehouseId: id }, { toWarehouseId: id }],
        },
      }),
    ]);
    if (pos || transfers) {
      throw new ConflictException(
        `This warehouse has ${pos} open purchase order(s) and ${transfers} open transfer(s). Finish or cancel them first.`,
      );
    }
  }

  private rethrowUnique(e: unknown): never {
    if (e instanceof PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictException('A warehouse with this name or code already exists');
    }
    throw e;
  }
}
```

- [ ] **Step 5: Controller and module**

```ts
// src/modules/inventory/warehouses.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { WarehousesService } from './warehouses.service';
import {
  CreateWarehouseDto,
  UpdateWarehouseDto,
  WarehouseStockQueryDto,
} from './dto/warehouse.dto';

/** Warehouses (ADMIN+). No auth module yet; see docs/api/inventory-workflows.md. */
@Controller('inventory/warehouses')
@UsePipes(ZodValidationPipe)
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  // ── GET /inventory/warehouses (ADMIN+) ──────────
  @Get()
  findAll() {
    return this.warehouses.findAll();
  }

  // ── POST /inventory/warehouses (ADMIN+) ─────────
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateWarehouseDto) {
    return this.warehouses.create(dto);
  }

  // ── GET /inventory/warehouses/:id (ADMIN+) ──────
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.warehouses.findOne(id);
  }

  // ── GET /inventory/warehouses/:id/stock (ADMIN+) ──
  @Get(':id/stock')
  stock(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: WarehouseStockQueryDto,
  ) {
    return this.warehouses.stock(id, query);
  }

  // ── PATCH /inventory/warehouses/:id (ADMIN+) ────
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWarehouseDto) {
    return this.warehouses.update(id, dto);
  }

  // ── DELETE /inventory/warehouses/:id (ADMIN+) ───
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.warehouses.remove(id);
  }
}
```

In `inventory.module.ts` add `WarehousesController` to `controllers` and `WarehousesService` to `providers` (with imports).

- [ ] **Step 6: Run unit tests**

Run: `npx jest src/modules/inventory`
Expected: PASS.

- [ ] **Step 7: E2E fixtures**

```ts
// test/inventory-fixtures.ts
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

export async function createVariant(prisma: PrismaClient, run: string, suffix: string) {
  const product = await prisma.product.create({
    data: { name: `E2E ${run} ${suffix}`, slug: `e2e-${run}-${suffix}`.toLowerCase() },
  });
  return prisma.productVariant.create({
    data: { productId: product.id, sku: `E2E-${run}-${suffix}`, price: 100 },
  });
}

export function createWarehouse(prisma: PrismaClient, run: string, suffix: string) {
  return prisma.warehouse.create({
    data: { code: `E2E-${run}-${suffix}`, name: `E2E ${run} ${suffix}`, type: 'PHYSICAL' },
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

export function levelOf(prisma: PrismaClient, variantId: string, warehouseId: string) {
  return prisma.inventoryLevel.findUniqueOrThrow({
    where: { variantId_warehouseId: { variantId, warehouseId } },
  });
}
```

- [ ] **Step 8: Warehouses e2e**

```ts
// test/warehouses.e2e-spec.ts
import { bootApp, body, createVariant, levelOf, runTag, stockIn } from './inventory-fixtures';

const RUN = runTag();
type One<T = Record<string, unknown>> = { data: T };
type Wh = { id: string; code: string; isActive: boolean; counts: { locations: number; variantsStocked: number; unitsOnHand: number; stockValue: string } };

describe('Warehouses (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (ctx = await bootApp()));
  afterAll(async () => {
    await ctx.app.close();
    await ctx.prisma.$disconnect();
  });

  it('creates, lists with counts, and keeps code fixed', async () => {
    const created = await ctx.api()
      .post('/inventory/warehouses')
      .send({ code: `E2E-${RUN}-A`, name: `E2E ${RUN} A`, city: 'Dhaka' })
      .expect(201);
    const wh = body<One<Wh>>(created).data;
    expect(wh).toMatchObject({ code: `E2E-${RUN}-A`, isActive: true, counts: { locations: 0, unitsOnHand: 0 } });
    // UNASSIGNED exists but isn't counted
    await ctx.prisma.storageLocation.findUniqueOrThrow({
      where: { warehouseId_code: { warehouseId: wh.id, code: 'UNASSIGNED' } },
    });

    const variant = await createVariant(ctx.prisma, RUN, 'A1');
    await stockIn(ctx.prisma, ctx.inventory, variant.id, wh.id, 5, 20);

    const list = body<{ data: Wh[] }>(await ctx.api().get('/inventory/warehouses').expect(200));
    expect(list.data.find((w) => w.id === wh.id)?.counts).toMatchObject({
      variantsStocked: 1,
      unitsOnHand: 5,
    });
    expect(Number(list.data.find((w) => w.id === wh.id)?.counts.stockValue)).toBe(100);

    await ctx.api().patch(`/inventory/warehouses/${wh.id}`).send({ code: 'NEW' }).expect(400);

    const stock = await ctx.api().get(`/inventory/warehouses/${wh.id}/stock`).expect(200);
    expect(body<{ data: { onHand: number; variant: { sku: string } }[] }>(stock).data).toEqual([
      expect.objectContaining({ onHand: 5, variant: expect.objectContaining({ sku: variant.sku }) }),
    ]);
  });

  it('deactivating re-syncs storefront stock', async () => {
    const wh = body<One<Wh>>(
      await ctx.api().post('/inventory/warehouses').send({ code: `E2E-${RUN}-B`, name: `E2E ${RUN} B` }).expect(201),
    ).data;
    const variant = await createVariant(ctx.prisma, RUN, 'B1');
    await stockIn(ctx.prisma, ctx.inventory, variant.id, wh.id, 7);
    const stockOf = async () => (await ctx.prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).stock;
    expect(await stockOf()).toBe(7);

    await ctx.api().patch(`/inventory/warehouses/${wh.id}`).send({ isActive: false }).expect(200);
    expect(await stockOf()).toBe(0);
    await ctx.api().patch(`/inventory/warehouses/${wh.id}`).send({ isActive: true }).expect(200);
    expect(await stockOf()).toBe(7);
    expect((await levelOf(ctx.prisma, variant.id, wh.id)).onHand).toBe(7);
  });

  it('deletes only unused warehouses', async () => {
    const used = body<One<Wh>>(
      await ctx.api().post('/inventory/warehouses').send({ code: `E2E-${RUN}-C`, name: `E2E ${RUN} C` }).expect(201),
    ).data;
    const variant = await createVariant(ctx.prisma, RUN, 'C1');
    await stockIn(ctx.prisma, ctx.inventory, variant.id, used.id, 1);
    await ctx.api().delete(`/inventory/warehouses/${used.id}`).expect(409);

    const empty = body<One<Wh>>(
      await ctx.api().post('/inventory/warehouses').send({ code: `E2E-${RUN}-D`, name: `E2E ${RUN} D` }).expect(201),
    ).data;
    await ctx.api().delete(`/inventory/warehouses/${empty.id}`).expect(200);
    await ctx.api().get(`/inventory/warehouses/${empty.id}`).expect(404);
  });

  it('rejects a duplicate code and a non-uuid id', async () => {
    await ctx.api().post('/inventory/warehouses').send({ code: `E2E-${RUN}-A`, name: `E2E ${RUN} A2` }).expect(409);
    await ctx.api().get('/inventory/warehouses/not-a-uuid').expect(400);
  });
});
```

- [ ] **Step 9: Run e2e**

Run: `npm run test:e2e -- test/warehouses.e2e-spec.ts`
Expected: PASS (needs Postgres up; on `ECONNREFUSED` start it and re-run — do not skip).

- [ ] **Step 10: Commit**

```bash
git add src/modules/inventory/dto/warehouse.dto.ts src/modules/inventory/warehouses.* src/modules/inventory/inventory.module.ts test/inventory-fixtures.ts test/warehouses.e2e-spec.ts
git commit -m "feat(inventory): warehouses API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Purchase orders API

**Files:**
- Create: `src/modules/inventory/dto/purchase-order.dto.ts`
- Create: `src/modules/inventory/purchase-orders.service.ts`
- Create: `src/modules/inventory/purchase-orders.controller.ts`
- Create: `src/modules/inventory/purchase-orders.service.spec.ts`
- Modify: `src/modules/inventory/inventory.module.ts`
- Create: `test/purchase-orders.e2e-spec.ts`

**Interfaces:**
- Consumes: `InventoryService.receiveStock(tx, StockReceipt)` (Task 2 fields), `InventoryService.changeIncoming`, `InventoryService.getDefaultWarehouseId`; Task 1 helpers; Task 3 fixtures.
- Produces: `computeTotals(items, tax, shipping)`, `outstandingQty(item)`; routes `/purchase-orders…` and `GET /suppliers/:supplierId/purchase-orders`.

- [ ] **Step 1: DTOs**

```ts
// src/modules/inventory/dto/purchase-order.dto.ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateOrDateTime, pagination } from './inventory.dto';

/* ==========================================
   PURCHASE ORDER SCHEMAS & DTOS
   ========================================== */

export const purchaseOrderStatusEnum = z.enum([
  'DRAFT', 'SUBMITTED', 'CONFIRMED', 'PARTIAL', 'RECEIVED', 'CANCELLED', 'CLOSED',
]);

const money = z.number().nonnegative();
const note = z.string().trim().max(1000).nullable().optional();

export const purchaseOrderItemSchema = z.object({
  variantId: z.string().uuid(),
  warehouseId: z.string().uuid().optional(), // defaults to the default warehouse
  orderedQty: z.number().int().positive(),
  unitCost: money,
});

const items = z.array(purchaseOrderItemSchema).max(200);

export const createPurchaseOrderSchema = z.object({
  supplierId: z.string().uuid(),
  expectedAt: z.coerce.date().nullable().optional(),
  note,
  taxAmount: money.default(0),
  shippingAmount: money.default(0),
  items: items.default([]), // a draft may start empty; submit needs a line
});

export class CreatePurchaseOrderDto extends createZodDto(createPurchaseOrderSchema) {}

export const updatePurchaseOrderSchema = z.object({
  supplierId: z.string().uuid().optional(),
  expectedAt: z.coerce.date().nullable().optional(),
  note,
  taxAmount: money.optional(),
  shippingAmount: money.optional(),
  items: items.optional(), // replaces every line
});

export class UpdatePurchaseOrderDto extends createZodDto(updatePurchaseOrderSchema) {}

export const receivePurchaseOrderSchema = z.object({
  reference: z.string().trim().max(100).optional(), // supplier invoice / delivery note
  note: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z
        .object({
          itemId: z.string().uuid(),
          quantity: z.number().int().nonnegative(), // good units → stock
          damagedQty: z.number().int().nonnegative().default(0), // refused at the dock
          batchNumber: z.string().trim().min(1).max(100).optional(),
          manufacturedAt: z.coerce.date().optional(),
          expiresAt: z.coerce.date().optional(),
          locationId: z.string().uuid().optional(), // put-away rack
        })
        .refine((l) => l.quantity + l.damagedQty >= 1, {
          message: 'Receive at least one unit (good or damaged)',
          path: ['quantity'],
        }),
    )
    .min(1)
    .max(200)
    .refine((lines) => new Set(lines.map((l) => l.itemId)).size === lines.length, {
      message: 'Each itemId may appear only once',
    }),
});

export class ReceivePurchaseOrderDto extends createZodDto(receivePurchaseOrderSchema) {}

export const purchaseOrderQuerySchema = z.object({
  ...pagination,
  status: purchaseOrderStatusEnum.optional(),
  supplierId: z.string().uuid().optional(),
  search: z.string().trim().min(1).optional(), // PO number
  dateFrom: isoDateOrDateTime.optional(), // on createdAt
  dateTo: isoDateOrDateTime.optional(),
});

export class PurchaseOrderQueryDto extends createZodDto(purchaseOrderQuerySchema) {}
```

- [ ] **Step 2: Write the failing unit tests**

```ts
// src/modules/inventory/purchase-orders.service.spec.ts
import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { InventoryService } from './inventory.service';
import {
  computeTotals,
  outstandingQty,
  PurchaseOrdersService,
} from './purchase-orders.service';
import { receivePurchaseOrderSchema } from './dto/purchase-order.dto';

const item = (o: object = {}) => ({
  id: 'poi-1',
  variantId: 'v1',
  warehouseId: 'wh-1',
  orderedQty: 10,
  receivedQty: 0,
  damagedQty: 0,
  unitCost: new Decimal(50),
  status: 'PENDING',
  variant: { sku: 'SKU-1' },
  ...o,
});
const po = (o: object = {}) => ({
  id: 'po-1',
  poNumber: 'PO-2026-00001',
  supplierId: 'sup-1',
  status: 'SUBMITTED',
  taxAmount: new Decimal(0),
  shippingAmount: new Decimal(0),
  items: [item()],
  ...o,
});

function mockDb() {
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'po-1' }]),
    $executeRaw: jest.fn(),
    purchaseOrder: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(po()),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'po-1' }),
    },
    purchaseOrderItem: { update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
    supplier: { findUnique: jest.fn().mockResolvedValue({ isActive: true, name: 'Bengal' }) },
    productVariant: { findMany: jest.fn().mockResolvedValue([{ id: 'v1' }]) },
    warehouse: { findMany: jest.fn().mockResolvedValue([{ id: 'wh-1' }]) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((fn: (t: typeof db) => unknown) => fn(db));
  return db;
}

describe('computeTotals', () => {
  it('sums lines and adds tax and shipping', () => {
    const t = computeTotals(
      [{ orderedQty: 3, unitCost: 12.5 }, { orderedQty: 2, unitCost: new Decimal(100) }],
      10,
      5.25,
    );
    expect(t.lineTotals.map(String)).toEqual(['37.5', '200']);
    expect(t.subtotalAmount.toString()).toBe('237.5');
    expect(t.totalAmount.toString()).toBe('252.75');
  });
});

describe('outstandingQty', () => {
  it('is ordered minus received and damaged, 0 once cancelled', () => {
    expect(outstandingQty(item({ receivedQty: 4, damagedQty: 1 }))).toBe(5);
    expect(outstandingQty(item({ status: 'CANCELLED' }))).toBe(0);
  });
});

describe('receivePurchaseOrderSchema', () => {
  it('refuses the same line twice', () => {
    const line = { itemId: '0199a1b2-0000-7000-8000-000000000001', quantity: 1 };
    expect(receivePurchaseOrderSchema.safeParse({ lines: [line, line] }).success).toBe(false);
  });
});

describe('PurchaseOrdersService', () => {
  let service: PurchaseOrdersService;
  let db: ReturnType<typeof mockDb>;
  const inventory = {
    receiveStock: jest.fn(),
    changeIncoming: jest.fn(),
    getDefaultWarehouseId: jest.fn().mockResolvedValue('wh-default'),
  };

  beforeEach(async () => {
    db = mockDb();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: PrismaService, useValue: db },
        { provide: InventoryService, useValue: inventory },
      ],
    }).compile();
    service = moduleRef.get(PurchaseOrdersService);
    jest.spyOn(service, 'findOne').mockResolvedValue({ data: {} } as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('submit adds every line to incoming', async () => {
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(po({ status: 'DRAFT' }));
    await service.submit('po-1');
    expect(inventory.changeIncoming).toHaveBeenCalledWith(db, 'v1', 'wh-1', 10);
    expect(db.purchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUBMITTED' }) }),
    );
  });

  it('submit refuses an empty or non-draft PO', async () => {
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(po({ status: 'DRAFT', items: [] }));
    await expect(service.submit('po-1')).rejects.toThrow(BadRequestException);
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(po({ status: 'RECEIVED' }));
    await expect(service.submit('po-1')).rejects.toThrow(ConflictException);
  });

  it('receive books good units at the line cost and releases incoming', async () => {
    await service.receive('po-1', { lines: [{ itemId: 'poi-1', quantity: 4, damagedQty: 1 }] }, 'u1');
    expect(inventory.receiveStock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        variantId: 'v1',
        warehouseId: 'wh-1',
        quantity: 4,
        unitCost: new Decimal(50),
        supplierId: 'sup-1',
        purchaseOrderItemId: 'poi-1',
        referenceType: 'PURCHASE_ORDER',
        referenceId: 'po-1',
        note: 'PO-2026-00001',
        userId: 'u1',
      }),
    );
    expect(inventory.changeIncoming).toHaveBeenCalledWith(db, 'v1', 'wh-1', -5);
    expect(db.purchaseOrderItem.update).toHaveBeenCalledWith({
      where: { id: 'poi-1' },
      data: { receivedQty: 4, damagedQty: 1, status: 'PARTIAL' },
    });
    expect(db.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: 'po-1' },
      data: { status: 'PARTIAL' },
    });
  });

  it('receive marks the PO RECEIVED with receivedAt when nothing is left', async () => {
    await service.receive('po-1', { lines: [{ itemId: 'poi-1', quantity: 10, damagedQty: 0 }] });
    expect(db.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: 'po-1' },
      data: { status: 'RECEIVED', receivedAt: expect.any(Date) },
    });
  });

  it('receive refuses more than outstanding and touches nothing', async () => {
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(po({ items: [item({ receivedQty: 8 })] }));
    await expect(
      service.receive('po-1', { lines: [{ itemId: 'poi-1', quantity: 3, damagedQty: 0 }] }),
    ).rejects.toThrow(BadRequestException);
    expect(inventory.receiveStock).not.toHaveBeenCalled();
  });

  it('receive is all or nothing (an unknown line fails the request)', async () => {
    await expect(
      service.receive('po-1', {
        lines: [
          { itemId: 'poi-1', quantity: 1, damagedQty: 0 },
          { itemId: 'poi-x', quantity: 1, damagedQty: 0 },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(inventory.receiveStock).not.toHaveBeenCalled(); // validated before writing
  });

  it('cancel on a PARTIAL PO says to close it', async () => {
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(po({ status: 'PARTIAL' }));
    await expect(service.cancel('po-1')).rejects.toThrow(
      new ConflictException("PO-2026-00001 has receipts and can't be cancelled; close it instead"),
    );
  });

  it('cancel of a submitted PO releases incoming', async () => {
    await service.cancel('po-1');
    expect(inventory.changeIncoming).toHaveBeenCalledWith(db, 'v1', 'wh-1', -10);
  });

  it('close cancels outstanding lines and releases their incoming', async () => {
    db.purchaseOrder.findUniqueOrThrow.mockResolvedValue(
      po({ status: 'PARTIAL', items: [item({ receivedQty: 6 })] }),
    );
    await service.close('po-1');
    expect(inventory.changeIncoming).toHaveBeenCalledWith(db, 'v1', 'wh-1', -4);
    expect(db.purchaseOrderItem.update).toHaveBeenCalledWith({
      where: { id: 'poi-1' },
      data: { status: 'CANCELLED' },
    });
  });

  it('create defaults a line to the default warehouse and computes totals', async () => {
    db.warehouse.findMany.mockResolvedValue([{ id: 'wh-default' }]);
    await service.create({
      supplierId: 'sup-1',
      taxAmount: 0,
      shippingAmount: 0,
      items: [{ variantId: 'v1', orderedQty: 2, unitCost: 5 }],
    });
    const data = db.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.items.create[0]).toMatchObject({ warehouseId: 'wh-default', orderedQty: 2 });
    expect(String(data.totalAmount)).toBe('10');
  });

  it('create refuses duplicate (variant, warehouse) lines', async () => {
    await expect(
      service.create({
        supplierId: 'sup-1',
        taxAmount: 0,
        shippingAmount: 0,
        items: [
          { variantId: 'v1', warehouseId: 'wh-1', orderedQty: 1, unitCost: 1 },
          { variantId: 'v1', warehouseId: 'wh-1', orderedQty: 2, unitCost: 1 },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/modules/inventory/purchase-orders.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the service**

```ts
// src/modules/inventory/purchase-orders.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma/client';
import { dateRangeFilter } from 'src/common/utils/date-range.util';
import { InventoryService } from './inventory.service';
import {
  assertStatus,
  lockDocument,
  nextDocumentNumber,
  pageMeta,
  runDocumentTx,
  toUserRef,
  toVariantLine,
  USER_REF_SELECT,
  VARIANT_LINE_SELECT,
  WAREHOUSE_REF_SELECT,
} from './documents.util';
import {
  CreatePurchaseOrderDto,
  PurchaseOrderQueryDto,
  ReceivePurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from './dto/purchase-order.dto';

type LineInput = { variantId: string; warehouseId?: string; orderedQty: number; unitCost: Decimal.Value };
type ResolvedLine = LineInput & { warehouseId: string };

/** Line totals (4 dp) and PO subtotal/total (2 dp), computed server-side. */
export function computeTotals(
  items: { orderedQty: number; unitCost: Decimal.Value }[],
  taxAmount: Decimal.Value,
  shippingAmount: Decimal.Value,
) {
  const lineTotals = items.map((i) =>
    new Decimal(i.unitCost).mul(i.orderedQty).toDecimalPlaces(4),
  );
  const subtotalAmount = lineTotals
    .reduce((a, b) => a.plus(b), new Decimal(0))
    .toDecimalPlaces(2);
  return {
    lineTotals,
    subtotalAmount,
    totalAmount: subtotalAmount.plus(taxAmount).plus(shippingAmount).toDecimalPlaces(2),
  };
}

/** Units still expected on a line (0 once the line is cancelled). */
export function outstandingQty(i: {
  orderedQty: number;
  receivedQty: number;
  damagedQty: number;
  status: string;
}) {
  return i.status === 'CANCELLED' ? 0 : i.orderedQty - i.receivedQty - i.damagedQty;
}

const PO_INCLUDE = {
  supplier: { select: { id: true, code: true, name: true } },
  createdByUser: { select: USER_REF_SELECT },
  approvedByUser: { select: USER_REF_SELECT },
  items: {
    orderBy: { createdAt: 'asc' },
    include: {
      variant: { select: VARIANT_LINE_SELECT },
      warehouse: { select: WAREHOUSE_REF_SELECT },
    },
  },
} satisfies Prisma.PurchaseOrderInclude;

type PoRow = Prisma.PurchaseOrderGetPayload<{ include: typeof PO_INCLUDE }>;

function toPoView(po: PoRow) {
  const { createdByUser, approvedByUser, items, ...rest } = po;
  return {
    ...rest,
    createdBy: toUserRef(createdByUser),
    approvedBy: toUserRef(approvedByUser),
    items: items.map((i) => ({
      ...i,
      variant: toVariantLine(i.variant),
      outstandingQty: outstandingQty(i),
    })),
  };
}

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  // ─── Reads ──────────────────────────────────────

  async findAll(query: PurchaseOrderQueryDto) {
    const { page, limit, status, supplierId, search, dateFrom, dateTo } = query;
    const where: Prisma.PurchaseOrderWhereInput = {
      ...(status && { status }),
      ...(supplierId && { supplierId }),
      ...(search && { poNumber: { contains: search, mode: 'insensitive' } }),
      createdAt: dateRangeFilter(dateFrom, dateTo),
    };
    const [total, rows] = await Promise.all([
      this.prisma.purchaseOrder.count({ where }),
      this.prisma.purchaseOrder.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          supplier: { select: { id: true, code: true, name: true } },
          createdByUser: { select: USER_REF_SELECT },
          items: { select: { orderedQty: true, receivedQty: true, damagedQty: true } },
        },
      }),
    ]);
    return {
      data: rows.map(({ items, createdByUser, ...po }) => ({
        ...po,
        createdBy: toUserRef(createdByUser),
        lineCount: items.length,
        orderedUnits: items.reduce((n, i) => n + i.orderedQty, 0),
        receivedUnits: items.reduce((n, i) => n + i.receivedQty, 0),
        damagedUnits: items.reduce((n, i) => n + i.damagedQty, 0),
      })),
      meta: pageMeta(total, page, limit),
    };
  }

  async findForSupplier(supplierId: string, query: PurchaseOrderQueryDto) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return this.findAll({ ...query, supplierId });
  }

  async findOne(id: string) {
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: PO_INCLUDE,
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    return { data: toPoView(po) };
  }

  // ─── Draft editing ──────────────────────────────

  async create(dto: CreatePurchaseOrderDto, actedBy?: string) {
    const po = await runDocumentTx(this.prisma, async (tx) => {
      await this.assertActiveSupplier(tx, dto.supplierId);
      const lines = await this.resolveLines(tx, dto.items);
      const totals = computeTotals(lines, dto.taxAmount, dto.shippingAmount);
      return tx.purchaseOrder.create({
        data: {
          poNumber: await nextDocumentNumber(tx, 'PO'),
          supplierId: dto.supplierId,
          expectedAt: dto.expectedAt ?? null,
          note: dto.note ?? null,
          taxAmount: dto.taxAmount,
          shippingAmount: dto.shippingAmount,
          subtotalAmount: totals.subtotalAmount,
          totalAmount: totals.totalAmount,
          createdByUserId: actedBy ?? null,
          items: { create: this.lineRows(lines, totals.lineTotals) },
        },
        select: { id: true },
      });
    });
    return this.findOne(po.id);
  }

  async update(id: string, dto: UpdatePurchaseOrderDto) {
    await runDocumentTx(this.prisma, async (tx) => {
      const po = await this.lock(tx, id);
      assertStatus(po, ['DRAFT'], po.poNumber, 'edited');
      if (dto.supplierId) await this.assertActiveSupplier(tx, dto.supplierId);

      const lines: ResolvedLine[] = dto.items
        ? await this.resolveLines(tx, dto.items)
        : po.items.map((i) => ({
            variantId: i.variantId,
            warehouseId: i.warehouseId,
            orderedQty: i.orderedQty,
            unitCost: i.unitCost,
          }));
      const taxAmount = dto.taxAmount ?? po.taxAmount;
      const shippingAmount = dto.shippingAmount ?? po.shippingAmount;
      const totals = computeTotals(lines, taxAmount, shippingAmount);

      if (dto.items) {
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
      }
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          ...(dto.supplierId && { supplierId: dto.supplierId }),
          ...(dto.expectedAt !== undefined && { expectedAt: dto.expectedAt }),
          ...(dto.note !== undefined && { note: dto.note }),
          taxAmount,
          shippingAmount,
          subtotalAmount: totals.subtotalAmount,
          totalAmount: totals.totalAmount,
          ...(dto.items && { items: { create: this.lineRows(lines, totals.lineTotals) } }),
        },
      });
    });
    return this.findOne(id);
  }

  async remove(id: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const po = await this.lock(tx, id);
      assertStatus(po, ['DRAFT'], po.poNumber, 'deleted');
      await tx.purchaseOrder.delete({ where: { id } });
    });
    return { data: { id, result: 'deleted' as const } };
  }

  // ─── Workflow ───────────────────────────────────

  async submit(id: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const po = await this.lock(tx, id);
      assertStatus(po, ['DRAFT'], po.poNumber, 'submitted');
      if (!po.items.length) {
        throw new BadRequestException('Add at least one line before submitting');
      }
      await this.assertActiveSupplier(tx, po.supplierId);
      for (const i of po.items) {
        await this.inventory.changeIncoming(tx, i.variantId, i.warehouseId, i.orderedQty);
      }
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'SUBMITTED', orderedAt: new Date() },
      });
    });
    return this.findOne(id);
  }

  async confirm(id: string, actedBy?: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const po = await this.lock(tx, id);
      assertStatus(po, ['SUBMITTED'], po.poNumber, 'confirmed');
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'CONFIRMED', approvedByUserId: actedBy ?? null },
      });
    });
    return this.findOne(id);
  }

  async receive(id: string, dto: ReceivePurchaseOrderDto, actedBy?: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const po = await this.lock(tx, id);
      assertStatus(po, ['SUBMITTED', 'CONFIRMED', 'PARTIAL'], po.poNumber, 'received');

      // Validate every line before writing anything.
      const byId = new Map(po.items.map((i) => [i.id, i]));
      for (const line of dto.lines) {
        const item = byId.get(line.itemId);
        if (!item) {
          throw new BadRequestException(`Line ${line.itemId} is not on ${po.poNumber}`);
        }
        const left = outstandingQty(item);
        if (line.quantity + line.damagedQty > left) {
          throw new BadRequestException(
            `${item.variant.sku}: ${left} outstanding, ${line.quantity + line.damagedQty} received`,
          );
        }
      }

      const note = [po.poNumber, dto.note].filter(Boolean).join(' — ');
      for (const line of dto.lines) {
        const item = byId.get(line.itemId)!;
        if (line.quantity > 0) {
          await this.inventory.receiveStock(tx, {
            variantId: item.variantId,
            warehouseId: item.warehouseId,
            locationId: line.locationId,
            quantity: line.quantity,
            unitCost: item.unitCost, // updates the level's weighted-average cost
            supplierId: po.supplierId,
            batchNumber: line.batchNumber,
            manufacturedAt: line.manufacturedAt,
            expiresAt: line.expiresAt,
            reference: dto.reference,
            note,
            userId: actedBy,
            purchaseOrderItemId: item.id,
            referenceType: 'PURCHASE_ORDER',
            referenceId: po.id,
          });
        }
        const arrived = line.quantity + line.damagedQty;
        await this.inventory.changeIncoming(tx, item.variantId, item.warehouseId, -arrived);

        const receivedQty = item.receivedQty + line.quantity;
        const damagedQty = item.damagedQty + line.damagedQty;
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: {
            receivedQty,
            damagedQty,
            status: receivedQty + damagedQty >= item.orderedQty ? 'RECEIVED' : 'PARTIAL',
          },
        });
        byId.set(item.id, { ...item, receivedQty, damagedQty });
      }

      const done = [...byId.values()].every((i) => outstandingQty(i) === 0);
      await tx.purchaseOrder.update({
        where: { id },
        data: done ? { status: 'RECEIVED', receivedAt: new Date() } : { status: 'PARTIAL' },
      });
    });
    return this.findOne(id);
  }

  async cancel(id: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const po = await this.lock(tx, id);
      if (po.status === 'PARTIAL') {
        throw new ConflictException(
          `${po.poNumber} has receipts and can't be cancelled; close it instead`,
        );
      }
      assertStatus(po, ['DRAFT', 'SUBMITTED', 'CONFIRMED'], po.poNumber, 'cancelled');
      if (po.status !== 'DRAFT') {
        for (const i of po.items) {
          await this.inventory.changeIncoming(tx, i.variantId, i.warehouseId, -outstandingQty(i));
        }
      }
      await tx.purchaseOrderItem.updateMany({
        where: { purchaseOrderId: id },
        data: { status: 'CANCELLED' },
      });
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
    });
    return this.findOne(id);
  }

  /** "Cancel the rest" / "Close short": stop expecting what hasn't arrived. */
  async close(id: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const po = await this.lock(tx, id);
      assertStatus(po, ['PARTIAL', 'RECEIVED'], po.poNumber, 'closed');
      for (const i of po.items) {
        const left = outstandingQty(i);
        if (left === 0) continue;
        await this.inventory.changeIncoming(tx, i.variantId, i.warehouseId, -left);
        await tx.purchaseOrderItem.update({
          where: { id: i.id },
          data: { status: 'CANCELLED' },
        });
      }
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'CLOSED' } });
    });
    return this.findOne(id);
  }

  // ─── Helpers ────────────────────────────────────

  private async lock(tx: Prisma.TransactionClient, id: string) {
    if (!(await lockDocument(tx, 'purchase_orders', id))) {
      throw new NotFoundException('Purchase order not found');
    }
    return tx.purchaseOrder.findUniqueOrThrow({
      where: { id },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: { variant: { select: { sku: true } } },
        },
      },
    });
  }

  private async assertActiveSupplier(tx: Prisma.TransactionClient, supplierId: string) {
    const supplier = await tx.supplier.findUnique({
      where: { id: supplierId },
      select: { isActive: true, name: true },
    });
    if (!supplier) throw new BadRequestException(`Supplier "${supplierId}" not found`);
    if (!supplier.isActive) {
      throw new BadRequestException(`Supplier "${supplier.name}" is inactive`);
    }
  }

  /** Fills default warehouses and checks variants, warehouses, duplicates. */
  private async resolveLines(
    tx: Prisma.TransactionClient,
    items: LineInput[],
  ): Promise<ResolvedLine[]> {
    if (!items.length) return [];
    const defaultId = items.some((i) => !i.warehouseId)
      ? await this.inventory.getDefaultWarehouseId(tx)
      : null;
    const lines = items.map((i) => ({ ...i, warehouseId: i.warehouseId ?? defaultId! }));

    const keys = new Set<string>();
    for (const l of lines) {
      const key = `${l.variantId}|${l.warehouseId}`;
      if (keys.has(key)) {
        throw new BadRequestException(
          'Each variant may appear once per receiving warehouse',
        );
      }
      keys.add(key);
    }

    const variantIds = [...new Set(lines.map((l) => l.variantId))];
    const warehouseIds = [...new Set(lines.map((l) => l.warehouseId))];
    const [variants, warehouses] = await Promise.all([
      tx.productVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true } }),
      tx.warehouse.findMany({
        where: { id: { in: warehouseIds }, isActive: true },
        select: { id: true },
      }),
    ]);
    const missingVariant = variantIds.find((id) => !variants.some((v) => v.id === id));
    if (missingVariant) throw new BadRequestException(`Variant "${missingVariant}" not found`);
    const badWarehouse = warehouseIds.find((id) => !warehouses.some((w) => w.id === id));
    if (badWarehouse) {
      throw new BadRequestException(`Warehouse "${badWarehouse}" not found or inactive`);
    }
    return lines;
  }

  private lineRows(lines: ResolvedLine[], lineTotals: Decimal[]) {
    return lines.map((l, n) => ({
      variantId: l.variantId,
      warehouseId: l.warehouseId,
      orderedQty: l.orderedQty,
      unitCost: new Decimal(l.unitCost),
      totalCost: lineTotals[n],
    }));
  }
}
```

- [ ] **Step 5: Controller and module**

```ts
// src/modules/inventory/purchase-orders.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  CreatePurchaseOrderDto,
  PurchaseOrderQueryDto,
  ReceivePurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from './dto/purchase-order.dto';

/**
 * Purchase orders (ADMIN+). No auth module yet: `actedBy` (query) is only
 * recorded, as on the rest of inventory.
 */
@Controller()
@UsePipes(ZodValidationPipe)
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrders: PurchaseOrdersService) {}

  // ── GET /purchase-orders ────────────────────────
  @Get('purchase-orders')
  findAll(@Query() query: PurchaseOrderQueryDto) {
    return this.purchaseOrders.findAll(query);
  }

  // ── POST /purchase-orders ───────────────────────
  @Post('purchase-orders')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreatePurchaseOrderDto, @Query('actedBy') actedBy?: string) {
    return this.purchaseOrders.create(dto, actedBy);
  }

  // ── GET /suppliers/:supplierId/purchase-orders ──
  @Get('suppliers/:supplierId/purchase-orders')
  findForSupplier(
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
    @Query() query: PurchaseOrderQueryDto,
  ) {
    return this.purchaseOrders.findForSupplier(supplierId, query);
  }

  // ── GET /purchase-orders/:id ────────────────────
  @Get('purchase-orders/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchaseOrders.findOne(id);
  }

  // ── PATCH /purchase-orders/:id (DRAFT) ──────────
  @Patch('purchase-orders/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePurchaseOrderDto) {
    return this.purchaseOrders.update(id, dto);
  }

  // ── DELETE /purchase-orders/:id (DRAFT) ─────────
  @Delete('purchase-orders/:id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchaseOrders.remove(id);
  }

  @Post('purchase-orders/:id/submit')
  @HttpCode(HttpStatus.OK)
  submit(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchaseOrders.submit(id);
  }

  @Post('purchase-orders/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@Param('id', ParseUUIDPipe) id: string, @Query('actedBy') actedBy?: string) {
    return this.purchaseOrders.confirm(id, actedBy);
  }

  @Post('purchase-orders/:id/receive')
  @HttpCode(HttpStatus.OK)
  receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceivePurchaseOrderDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.purchaseOrders.receive(id, dto, actedBy);
  }

  @Post('purchase-orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchaseOrders.cancel(id);
  }

  @Post('purchase-orders/:id/close')
  @HttpCode(HttpStatus.OK)
  close(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchaseOrders.close(id);
  }
}
```

Register `PurchaseOrdersController` / `PurchaseOrdersService` in `inventory.module.ts`.

- [ ] **Step 6: Run unit tests**

Run: `npx jest src/modules/inventory`
Expected: PASS.

- [ ] **Step 7: E2E**

```ts
// test/purchase-orders.e2e-spec.ts
import { bootApp, body, createVariant, createWarehouse, levelOf, runTag } from './inventory-fixtures';

const RUN = runTag();
type Po = {
  id: string;
  poNumber: string;
  status: string;
  subtotalAmount: string;
  totalAmount: string;
  receivedAt: string | null;
  items: { id: string; status: string; receivedQty: number; damagedQty: number; outstandingQty: number }[];
};
const data = <T>(res: Parameters<typeof body>[0]) => body<{ data: T }>(res).data;

describe('Purchase orders (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  let supplierId: string;
  let warehouseId: string;
  let variantId: string;

  beforeAll(async () => {
    ctx = await bootApp();
    supplierId = (await ctx.prisma.supplier.create({ data: { code: `E2E-${RUN}`, name: `E2E ${RUN}` } })).id;
    warehouseId = (await createWarehouse(ctx.prisma, RUN, 'PO')).id;
    variantId = (await createVariant(ctx.prisma, RUN, 'PO1')).id;
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.prisma.$disconnect();
  });

  const newPo = async (orderedQty = 10) =>
    data<Po>(
      await ctx.api()
        .post('/purchase-orders')
        .send({
          supplierId,
          taxAmount: 5,
          shippingAmount: 10,
          items: [{ variantId, warehouseId, orderedQty, unitCost: 50 }],
        })
        .expect(201),
    );

  it('partial receive, then close short', async () => {
    const po = await newPo();
    expect(po).toMatchObject({ status: 'DRAFT', poNumber: expect.stringMatching(/^PO-\d{4}-\d{5}$/) });
    expect(Number(po.subtotalAmount)).toBe(500);
    expect(Number(po.totalAmount)).toBe(515);

    await ctx.api().post(`/purchase-orders/${po.id}/submit`).expect(200);
    expect((await levelOf(ctx.prisma, variantId, warehouseId)).incoming).toBe(10);
    await ctx.api().post(`/purchase-orders/${po.id}/confirm`).expect(200);

    const received = data<Po>(
      await ctx.api()
        .post(`/purchase-orders/${po.id}/receive`)
        .send({ reference: 'INV-1', lines: [{ itemId: po.items[0].id, quantity: 4, damagedQty: 1 }] })
        .expect(200),
    );
    expect(received.status).toBe('PARTIAL');
    expect(received.items[0]).toMatchObject({ receivedQty: 4, damagedQty: 1, outstandingQty: 5, status: 'PARTIAL' });

    const level = await levelOf(ctx.prisma, variantId, warehouseId);
    expect(level).toMatchObject({ onHand: 4, incoming: 5 });
    expect(Number(level.unitCost)).toBe(50);
    expect((await ctx.prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock).toBe(4);

    const movement = await ctx.prisma.inventoryMovement.findFirstOrThrow({
      where: { referenceType: 'PURCHASE_ORDER', referenceId: po.id },
      include: { batch: true },
    });
    expect(movement.note).toMatch(new RegExp(`^${po.poNumber}`));
    expect(movement.batch?.purchaseOrderItemId).toBe(po.items[0].id);

    await ctx.api()
      .post(`/purchase-orders/${po.id}/receive`)
      .send({ lines: [{ itemId: po.items[0].id, quantity: 6 }] })
      .expect(400);
    await ctx.api().post(`/purchase-orders/${po.id}/cancel`).expect(409);

    const closed = data<Po>(await ctx.api().post(`/purchase-orders/${po.id}/close`).expect(200));
    expect(closed.status).toBe('CLOSED');
    expect(closed.items[0].status).toBe('CANCELLED');
    expect((await levelOf(ctx.prisma, variantId, warehouseId)).incoming).toBe(0);
  });

  it('full receive sets RECEIVED and receivedAt; drafts edit and delete', async () => {
    const po = await newPo(3);
    const edited = data<Po>(
      await ctx.api()
        .patch(`/purchase-orders/${po.id}`)
        .send({ shippingAmount: 0, items: [{ variantId, warehouseId, orderedQty: 2, unitCost: 50 }] })
        .expect(200),
    );
    expect(Number(edited.totalAmount)).toBe(105);
    await ctx.api().post(`/purchase-orders/${po.id}/submit`).expect(200);
    await ctx.api().patch(`/purchase-orders/${po.id}`).send({ note: 'late' }).expect(409);

    const done = data<Po>(
      await ctx.api()
        .post(`/purchase-orders/${po.id}/receive`)
        .send({ lines: [{ itemId: edited.items[0].id, quantity: 2 }] })
        .expect(200),
    );
    expect(done.status).toBe('RECEIVED');
    expect(done.receivedAt).not.toBeNull();

    const draft = await newPo(1);
    await ctx.api().delete(`/purchase-orders/${draft.id}`).expect(200);
    await ctx.api().get(`/purchase-orders/${draft.id}`).expect(404);
  });

  it('lists by supplier and status', async () => {
    const res = body<{ data: Po[]; meta: { total: number } }>(
      await ctx.api().get(`/suppliers/${supplierId}/purchase-orders?status=CLOSED`).expect(200),
    );
    expect(res.meta.total).toBe(1);
    expect(res.data[0].status).toBe('CLOSED');
  });
});
```

- [ ] **Step 8: Run e2e**

Run: `npm run test:e2e -- test/purchase-orders.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/modules/inventory/dto/purchase-order.dto.ts src/modules/inventory/purchase-orders.* src/modules/inventory/inventory.module.ts test/purchase-orders.e2e-spec.ts
git commit -m "feat(inventory): purchase orders API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Stock adjustment documents API

**Files:**
- Create: `src/modules/inventory/dto/stock-adjustment.dto.ts`
- Create: `src/modules/inventory/stock-adjustments.service.ts`
- Create: `src/modules/inventory/stock-adjustments.controller.ts`
- Create: `src/modules/inventory/stock-adjustments.service.spec.ts`
- Modify: `src/modules/inventory/inventory.module.ts`
- Create: `test/stock-adjustments.e2e-spec.ts`

**Interfaces:**
- Consumes: `InventoryService.applyAdjustment(tx, id, userId, { requireStatus: 'APPROVED' })` (Task 2); Task 1 helpers; fixtures.
- Produces: routes under `/inventory/adjustments` (`GET /`, `POST /requests`, `GET|PATCH /:id`, `POST /:id/{approve,apply,reject,cancel}`).

- [ ] **Step 1: DTOs**

```ts
// src/modules/inventory/dto/stock-adjustment.dto.ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateOrDateTime, pagination } from './inventory.dto';

/* ==========================================
   STOCK ADJUSTMENT DOCUMENTS
   (the direct POST /inventory/adjustments stays in inventory.dto.ts)
   ========================================== */

export const adjustmentTypeEnum = z.enum(['INCREASE', 'DECREASE', 'CYCLE_COUNT']);
export const adjustmentReasonEnum = z.enum([
  'CYCLE_COUNT', 'DAMAGE', 'THEFT', 'LOSS', 'EXPIRY', 'CORRECTION', 'OPENING_STOCK', 'PROMOTIONAL', 'OTHER',
]);
export const adjustmentStatusEnum = z.enum(['PENDING', 'APPROVED', 'APPLIED', 'REJECTED', 'CANCELLED']);

export const adjustmentLineSchema = z.object({
  variantId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(), // omitted → whole warehouse
  expectedQty: z.number().int().nullable().optional(), // ignored: the server snapshots it
  actualQty: z.number().int().nonnegative().nullable().optional(), // CYCLE_COUNT
  adjustmentQty: z.number().int().optional(), // INCREASE > 0, DECREASE < 0
});

const lines = z.array(adjustmentLineSchema).min(1).max(200);
const note = z.string().trim().max(1000).nullable().optional();

export const createAdjustmentRequestSchema = z.object({
  type: adjustmentTypeEnum,
  reason: adjustmentReasonEnum,
  note,
  items: lines,
});

export class CreateAdjustmentRequestDto extends createZodDto(createAdjustmentRequestSchema) {}

export const updateAdjustmentRequestSchema = z.object({
  reason: adjustmentReasonEnum.optional(),
  note,
  items: lines.optional(), // replaces every line, re-snapshotting expectedQty
});

export class UpdateAdjustmentRequestDto extends createZodDto(updateAdjustmentRequestSchema) {}

export const adjustmentQuerySchema = z.object({
  ...pagination,
  status: adjustmentStatusEnum.optional(),
  type: adjustmentTypeEnum.optional(),
  reason: adjustmentReasonEnum.optional(),
  warehouseId: z.string().uuid().optional(),
  dateFrom: isoDateOrDateTime.optional(),
  dateTo: isoDateOrDateTime.optional(),
});

export class AdjustmentQueryDto extends createZodDto(adjustmentQuerySchema) {}
```

- [ ] **Step 2: Write the failing unit tests**

```ts
// src/modules/inventory/stock-adjustments.service.spec.ts
import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { StockAdjustmentsService } from './stock-adjustments.service';

const LINE = { variantId: 'v1', warehouseId: 'wh-1' };

function mockDb() {
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'adj-1' }]),
    $executeRaw: jest.fn(),
    stockAdjustment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'adj-1', adjustmentNumber: 'ADJ-2026-00001', type: 'CYCLE_COUNT', status: 'PENDING',
      }),
      create: jest.fn().mockResolvedValue({ id: 'adj-1' }),
      update: jest.fn(),
    },
    stockAdjustmentItem: { deleteMany: jest.fn() },
    productVariant: { findMany: jest.fn().mockResolvedValue([{ id: 'v1' }]) },
    warehouse: { findMany: jest.fn().mockResolvedValue([{ id: 'wh-1' }]) },
    inventoryLevel: {
      findUnique: jest.fn().mockResolvedValue({ id: 'level-1', onHand: 10, unitCost: new Decimal(7) }),
    },
    locationStock: { findUnique: jest.fn().mockResolvedValue({ quantity: 4 }) },
    storageLocation: {
      findUnique: jest.fn().mockResolvedValue({
        warehouseId: 'wh-1', code: 'A-01-1', type: 'BIN', isActive: true, _count: { children: 0 },
      }),
    },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((fn: (t: typeof db) => unknown) => fn(db));
  return db;
}

describe('StockAdjustmentsService', () => {
  let service: StockAdjustmentsService;
  let db: ReturnType<typeof mockDb>;
  const inventory = { applyAdjustment: jest.fn() };

  beforeEach(async () => {
    db = mockDb();
    const moduleRef = await Test.createTestingModule({
      providers: [
        StockAdjustmentsService,
        { provide: PrismaService, useValue: db },
        { provide: InventoryService, useValue: inventory },
      ],
    }).compile();
    service = moduleRef.get(StockAdjustmentsService);
    jest.spyOn(service, 'findOne').mockResolvedValue({ data: {} } as never);
  });

  afterEach(() => jest.clearAllMocks());

  const createdItems = () =>
    db.stockAdjustment.create.mock.calls[0][0].data.items.create as Record<string, unknown>[];

  it('snapshots expectedQty and derives a cycle-count delta', async () => {
    await service.create({ type: 'CYCLE_COUNT', reason: 'CYCLE_COUNT', items: [{ ...LINE, actualQty: 7, expectedQty: 999 }] });
    expect(createdItems()[0]).toMatchObject({ expectedQty: 10, actualQty: 7, adjustmentQty: -3, unitCost: new Decimal(7) });
  });

  it('snapshots a location line from the location', async () => {
    await service.create({ type: 'CYCLE_COUNT', reason: 'CYCLE_COUNT', items: [{ ...LINE, locationId: 'loc-1', actualQty: 6 }] });
    expect(createdItems()[0]).toMatchObject({ expectedQty: 4, adjustmentQty: 2 });
  });

  it('requires the right sign for increases and decreases', async () => {
    await expect(
      service.create({ type: 'INCREASE', reason: 'CORRECTION', items: [{ ...LINE, adjustmentQty: -2 }] }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create({ type: 'DECREASE', reason: 'DAMAGE', items: [{ ...LINE, adjustmentQty: 2 }] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses duplicate lines, including whole-warehouse ones', async () => {
    await expect(
      service.create({ type: 'INCREASE', reason: 'CORRECTION', items: [{ ...LINE, adjustmentQty: 1 }, { ...LINE, adjustmentQty: 2 }] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a location that holds no stock directly', async () => {
    db.storageLocation.findUnique.mockResolvedValue({
      warehouseId: 'wh-1', code: 'A-01', type: 'RACK', isActive: true, _count: { children: 3 },
    });
    await expect(
      service.create({ type: 'CYCLE_COUNT', reason: 'CYCLE_COUNT', items: [{ ...LINE, locationId: 'loc-1', actualQty: 1 }] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('approve moves PENDING to APPROVED without touching stock', async () => {
    await service.approve('adj-1', 'u1');
    expect(db.stockAdjustment.update).toHaveBeenCalledWith({
      where: { id: 'adj-1' },
      data: { status: 'APPROVED', approvedByUserId: 'u1', approvedAt: expect.any(Date) },
    });
    expect(inventory.applyAdjustment).not.toHaveBeenCalled();
  });

  it('apply requires APPROVED', async () => {
    await service.apply('adj-1', 'u1');
    expect(inventory.applyAdjustment).toHaveBeenCalledWith(db, 'adj-1', 'u1', { requireStatus: 'APPROVED' });
  });

  it('edits, rejects and cancels only from the allowed statuses', async () => {
    db.stockAdjustment.findUniqueOrThrow.mockResolvedValue({
      id: 'adj-1', adjustmentNumber: 'ADJ-2026-00001', type: 'CYCLE_COUNT', status: 'APPROVED',
    });
    await expect(service.update('adj-1', { note: 'x' })).rejects.toThrow(ConflictException);
    await expect(service.reject('adj-1')).rejects.toThrow(ConflictException);
    await expect(service.cancel('adj-1')).resolves.toBeDefined();

    db.stockAdjustment.findUniqueOrThrow.mockResolvedValue({
      id: 'adj-1', adjustmentNumber: 'ADJ-2026-00001', type: 'CYCLE_COUNT', status: 'APPLIED',
    });
    await expect(service.cancel('adj-1')).rejects.toThrow(ConflictException);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/modules/inventory/stock-adjustments.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the service**

```ts
// src/modules/inventory/stock-adjustments.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma/client';
import type { AdjustmentType } from 'src/generated/prisma/enums';
import { dateRangeFilter } from 'src/common/utils/date-range.util';
import { InventoryService } from './inventory.service';
import {
  assertStatus,
  lockDocument,
  nextDocumentNumber,
  pageMeta,
  runDocumentTx,
  toUserRef,
  toVariantLine,
  USER_REF_SELECT,
  VARIANT_LINE_SELECT,
  WAREHOUSE_REF_SELECT,
} from './documents.util';
import {
  AdjustmentQueryDto,
  CreateAdjustmentRequestDto,
  UpdateAdjustmentRequestDto,
} from './dto/stock-adjustment.dto';

type LineInput = CreateAdjustmentRequestDto['items'][number];

/** Location types that never hold stock directly (as in InventoryService). */
const NON_STOCK_LOCATION_TYPES = ['ZONE', 'AISLE'];

const ADJUSTMENT_INCLUDE = {
  createdByUser: { select: USER_REF_SELECT },
  approvedByUser: { select: USER_REF_SELECT },
  items: {
    orderBy: { createdAt: 'asc' },
    include: {
      variant: { select: VARIANT_LINE_SELECT },
      warehouse: { select: WAREHOUSE_REF_SELECT },
      location: { select: { id: true, code: true } },
    },
  },
} satisfies Prisma.StockAdjustmentInclude;

@Injectable()
export class StockAdjustmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async findAll(query: AdjustmentQueryDto) {
    const { page, limit, status, type, reason, warehouseId, dateFrom, dateTo } = query;
    const where: Prisma.StockAdjustmentWhereInput = {
      ...(status && { status }),
      ...(type && { type }),
      ...(reason && { reason }),
      ...(warehouseId && { items: { some: { warehouseId } } }),
      createdAt: dateRangeFilter(dateFrom, dateTo),
    };
    const [total, rows] = await Promise.all([
      this.prisma.stockAdjustment.count({ where }),
      this.prisma.stockAdjustment.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          createdByUser: { select: USER_REF_SELECT },
          approvedByUser: { select: USER_REF_SELECT },
          _count: { select: { items: true } },
        },
      }),
    ]);
    return {
      data: rows.map(({ createdByUser, approvedByUser, _count, ...a }) => ({
        ...a,
        createdBy: toUserRef(createdByUser),
        approvedBy: toUserRef(approvedByUser),
        lineCount: _count.items,
      })),
      meta: pageMeta(total, page, limit),
    };
  }

  async findOne(id: string) {
    const a = await this.prisma.stockAdjustment.findUnique({
      where: { id },
      include: ADJUSTMENT_INCLUDE,
    });
    if (!a) throw new NotFoundException('Adjustment not found');
    const { createdByUser, approvedByUser, items, ...rest } = a;
    return {
      data: {
        ...rest,
        createdBy: toUserRef(createdByUser),
        approvedBy: toUserRef(approvedByUser),
        items: items.map((i) => ({ ...i, variant: toVariantLine(i.variant) })),
      },
    };
  }

  async create(dto: CreateAdjustmentRequestDto, actedBy?: string) {
    const created = await runDocumentTx(this.prisma, async (tx) =>
      tx.stockAdjustment.create({
        data: {
          adjustmentNumber: await nextDocumentNumber(tx, 'ADJ'),
          type: dto.type,
          reason: dto.reason,
          status: 'PENDING',
          note: dto.note ?? null,
          createdByUserId: actedBy ?? null,
          items: { create: await this.buildItems(tx, dto.type, dto.items) },
        },
        select: { id: true },
      }),
    );
    return this.findOne(created.id);
  }

  async update(id: string, dto: UpdateAdjustmentRequestDto) {
    await runDocumentTx(this.prisma, async (tx) => {
      const a = await this.lock(tx, id);
      assertStatus(a, ['PENDING'], a.adjustmentNumber, 'edited');
      const items = dto.items ? await this.buildItems(tx, a.type, dto.items) : null;
      if (items) await tx.stockAdjustmentItem.deleteMany({ where: { adjustmentId: id } });
      await tx.stockAdjustment.update({
        where: { id },
        data: {
          ...(dto.reason && { reason: dto.reason }),
          ...(dto.note !== undefined && { note: dto.note }),
          ...(items && { items: { create: items } }),
        },
      });
    });
    return this.findOne(id);
  }

  async approve(id: string, actedBy?: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const a = await this.lock(tx, id);
      assertStatus(a, ['PENDING'], a.adjustmentNumber, 'approved');
      await tx.stockAdjustment.update({
        where: { id },
        data: { status: 'APPROVED', approvedByUserId: actedBy ?? null, approvedAt: new Date() },
      });
    });
    return this.findOne(id);
  }

  /** APPROVED → APPLIED: the stock change, re-based on current counts. */
  async apply(id: string, actedBy?: string) {
    await runDocumentTx(this.prisma, (tx) =>
      this.inventory.applyAdjustment(tx, id, actedBy, { requireStatus: 'APPROVED' }),
    );
    return this.findOne(id);
  }

  async reject(id: string) {
    return this.setStatus(id, ['PENDING'], 'REJECTED', 'rejected');
  }

  async cancel(id: string) {
    return this.setStatus(id, ['PENDING', 'APPROVED'], 'CANCELLED', 'cancelled');
  }

  // ─── Helpers ────────────────────────────────────

  private async setStatus(
    id: string,
    from: ('PENDING' | 'APPROVED')[],
    to: 'REJECTED' | 'CANCELLED',
    action: string,
  ) {
    await runDocumentTx(this.prisma, async (tx) => {
      const a = await this.lock(tx, id);
      assertStatus(a, from, a.adjustmentNumber, action);
      await tx.stockAdjustment.update({ where: { id }, data: { status: to } });
    });
    return this.findOne(id);
  }

  private async lock(tx: Prisma.TransactionClient, id: string) {
    if (!(await lockDocument(tx, 'stock_adjustments', id))) {
      throw new NotFoundException('Adjustment not found');
    }
    return tx.stockAdjustment.findUniqueOrThrow({
      where: { id },
      select: { id: true, adjustmentNumber: true, type: true, status: true },
    });
  }

  /** Validates lines and snapshots expectedQty / unitCost from current stock. */
  private async buildItems(
    tx: Prisma.TransactionClient,
    type: AdjustmentType,
    lines: LineInput[],
  ): Promise<Prisma.StockAdjustmentItemCreateWithoutAdjustmentInput[]> {
    const variantIds = [...new Set(lines.map((l) => l.variantId))];
    const warehouseIds = [...new Set(lines.map((l) => l.warehouseId))];
    const [variants, warehouses] = await Promise.all([
      tx.productVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true } }),
      tx.warehouse.findMany({ where: { id: { in: warehouseIds } }, select: { id: true } }),
    ]);
    const missingVariant = variantIds.find((id) => !variants.some((v) => v.id === id));
    if (missingVariant) throw new BadRequestException(`Variant "${missingVariant}" not found`);
    const missingWarehouse = warehouseIds.find((id) => !warehouses.some((w) => w.id === id));
    if (missingWarehouse) throw new BadRequestException(`Warehouse "${missingWarehouse}" not found`);

    const seen = new Set<string>();
    const items: Prisma.StockAdjustmentItemCreateWithoutAdjustmentInput[] = [];
    for (const [n, line] of lines.entries()) {
      const label = `Line ${n + 1}`;
      // NULL locations don't collide in Postgres, so check here.
      const key = `${line.variantId}|${line.warehouseId}|${line.locationId ?? ''}`;
      if (seen.has(key)) {
        throw new BadRequestException(`${label}: the same variant and location appear twice`);
      }
      seen.add(key);
      if (line.locationId) await this.assertStockLocation(tx, line.locationId, line.warehouseId);

      const level = await tx.inventoryLevel.findUnique({
        where: { variantId_warehouseId: { variantId: line.variantId, warehouseId: line.warehouseId } },
        select: { id: true, onHand: true, unitCost: true },
      });
      let expectedQty = level?.onHand ?? 0;
      if (line.locationId) {
        expectedQty = level
          ? ((
              await tx.locationStock.findUnique({
                where: { inventoryLevelId_locationId: { inventoryLevelId: level.id, locationId: line.locationId } },
                select: { quantity: true },
              })
            )?.quantity ?? 0)
          : 0;
      }

      let adjustmentQty: number;
      let actualQty: number | null = null;
      if (type === 'CYCLE_COUNT') {
        if (line.actualQty == null) throw new BadRequestException(`${label}: a count needs actualQty`);
        actualQty = line.actualQty;
        adjustmentQty = actualQty - expectedQty;
      } else if (type === 'INCREASE') {
        if (!line.adjustmentQty || line.adjustmentQty <= 0) {
          throw new BadRequestException(`${label}: an increase needs a positive adjustmentQty`);
        }
        adjustmentQty = line.adjustmentQty;
      } else {
        if (!line.adjustmentQty || line.adjustmentQty >= 0) {
          throw new BadRequestException(`${label}: a decrease needs a negative adjustmentQty`);
        }
        adjustmentQty = line.adjustmentQty;
      }

      items.push({
        variant: { connect: { id: line.variantId } },
        warehouse: { connect: { id: line.warehouseId } },
        ...(line.locationId && { location: { connect: { id: line.locationId } } }),
        expectedQty,
        actualQty,
        adjustmentQty,
        unitCost: level?.unitCost ?? null,
      });
    }
    return items;
  }

  private async assertStockLocation(tx: Prisma.TransactionClient, locationId: string, warehouseId: string) {
    const loc = await tx.storageLocation.findUnique({
      where: { id: locationId },
      select: { warehouseId: true, code: true, type: true, isActive: true, _count: { select: { children: true } } },
    });
    if (!loc) throw new BadRequestException(`Location "${locationId}" not found`);
    if (loc.warehouseId !== warehouseId) {
      throw new BadRequestException(`Location "${loc.code}" belongs to a different warehouse`);
    }
    if (loc._count.children > 0 || NON_STOCK_LOCATION_TYPES.includes(loc.type)) {
      throw new BadRequestException(`${loc.code} doesn't hold stock directly. Pick one of its bins.`);
    }
  }
}
```

- [ ] **Step 5: Controller and module**

```ts
// src/modules/inventory/stock-adjustments.controller.ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { StockAdjustmentsService } from './stock-adjustments.service';
import {
  AdjustmentQueryDto,
  CreateAdjustmentRequestDto,
  UpdateAdjustmentRequestDto,
} from './dto/stock-adjustment.dto';

/**
 * Adjustment documents. The direct POST /inventory/adjustments and
 * /adjustments/bulk live on InventoryController. Static segments are
 * declared before :id, and :id is a UUID, so "bulk" never reaches it.
 * No auth module yet: approve/apply/reject are ADMIN+ by intent only.
 */
@Controller('inventory/adjustments')
@UsePipes(ZodValidationPipe)
export class StockAdjustmentsController {
  constructor(private readonly adjustments: StockAdjustmentsService) {}

  // ── GET /inventory/adjustments ──────────────────
  @Get()
  findAll(@Query() query: AdjustmentQueryDto) {
    return this.adjustments.findAll(query);
  }

  // ── POST /inventory/adjustments/requests ────────
  @Post('requests')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateAdjustmentRequestDto, @Query('actedBy') actedBy?: string) {
    return this.adjustments.create(dto, actedBy);
  }

  // ── GET /inventory/adjustments/:id ──────────────
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.adjustments.findOne(id);
  }

  // ── PATCH /inventory/adjustments/:id (PENDING) ──
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAdjustmentRequestDto) {
    return this.adjustments.update(id, dto);
  }

  // ── POST /inventory/adjustments/:id/approve (ADMIN+) ──
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@Param('id', ParseUUIDPipe) id: string, @Query('actedBy') actedBy?: string) {
    return this.adjustments.approve(id, actedBy);
  }

  // ── POST /inventory/adjustments/:id/apply (ADMIN+) ──
  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  apply(@Param('id', ParseUUIDPipe) id: string, @Query('actedBy') actedBy?: string) {
    return this.adjustments.apply(id, actedBy);
  }

  // ── POST /inventory/adjustments/:id/reject (ADMIN+) ──
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(@Param('id', ParseUUIDPipe) id: string) {
    return this.adjustments.reject(id);
  }

  // ── POST /inventory/adjustments/:id/cancel ──────
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.adjustments.cancel(id);
  }
}
```

Register in `inventory.module.ts`, listing `StockAdjustmentsController` **after** `InventoryController` in `controllers`.

- [ ] **Step 6: Run unit tests**

Run: `npx jest src/modules/inventory`
Expected: PASS.

- [ ] **Step 7: E2E**

```ts
// test/stock-adjustments.e2e-spec.ts
import { bootApp, body, createVariant, createWarehouse, levelOf, runTag, stockIn } from './inventory-fixtures';

const RUN = runTag();
type Adj = {
  id: string;
  adjustmentNumber: string;
  status: string;
  items: { expectedQty: number; actualQty: number | null; adjustmentQty: number; variant: { sku: string }; warehouse: { code: string }; location: null }[];
};
const data = <T>(res: Parameters<typeof body>[0]) => body<{ data: T }>(res).data;

describe('Stock adjustments (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  let warehouseId: string;
  let variantId: string;

  beforeAll(async () => {
    ctx = await bootApp();
    warehouseId = (await createWarehouse(ctx.prisma, RUN, 'ADJ')).id;
    variantId = (await createVariant(ctx.prisma, RUN, 'ADJ1')).id;
    await stockIn(ctx.prisma, ctx.inventory, variantId, warehouseId, 10);
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.prisma.$disconnect();
  });

  it('count → edit → approve → apply lands on the counted number', async () => {
    const created = data<Adj>(
      await ctx.api()
        .post('/inventory/adjustments/requests')
        .send({ type: 'CYCLE_COUNT', reason: 'CYCLE_COUNT', items: [{ variantId, warehouseId, actualQty: 7 }] })
        .expect(201),
    );
    expect(created).toMatchObject({ status: 'PENDING', adjustmentNumber: expect.stringMatching(/^ADJ-\d{4}-\d{5}$/) });
    expect(created.items[0]).toMatchObject({ expectedQty: 10, adjustmentQty: -3, location: null, variant: { sku: `E2E-${RUN}-ADJ1` } });
    expect((await levelOf(ctx.prisma, variantId, warehouseId)).onHand).toBe(10);

    const edited = data<Adj>(
      await ctx.api()
        .patch(`/inventory/adjustments/${created.id}`)
        .send({ items: [{ variantId, warehouseId, actualQty: 8 }] })
        .expect(200),
    );
    expect(edited.items[0]).toMatchObject({ expectedQty: 10, adjustmentQty: -2 });

    await ctx.api().post(`/inventory/adjustments/${created.id}/apply`).expect(409); // still PENDING
    await ctx.api().post(`/inventory/adjustments/${created.id}/approve`).expect(200);
    expect((await levelOf(ctx.prisma, variantId, warehouseId)).onHand).toBe(10);

    await stockIn(ctx.prisma, ctx.inventory, variantId, warehouseId, 2); // 12 now
    const applied = data<Adj>(await ctx.api().post(`/inventory/adjustments/${created.id}/apply`).expect(200));
    expect(applied.status).toBe('APPLIED');
    expect((await levelOf(ctx.prisma, variantId, warehouseId)).onHand).toBe(8);

    const movement = await ctx.prisma.inventoryMovement.findFirstOrThrow({
      where: { referenceType: 'ADJUSTMENT', referenceId: created.id },
    });
    expect(movement).toMatchObject({ type: 'ADJUSTMENT_DECREASE', quantity: 4 });
    expect(movement.note).toMatch(new RegExp(`^${created.adjustmentNumber}`));
  });

  it('reject and cancel follow the status rules', async () => {
    const a = data<Adj>(
      await ctx.api()
        .post('/inventory/adjustments/requests')
        .send({ type: 'INCREASE', reason: 'CORRECTION', items: [{ variantId, warehouseId, adjustmentQty: 3 }] })
        .expect(201),
    );
    await ctx.api().post(`/inventory/adjustments/${a.id}/reject`).expect(200);
    await ctx.api().post(`/inventory/adjustments/${a.id}/cancel`).expect(409);

    const b = data<Adj>(
      await ctx.api()
        .post('/inventory/adjustments/requests')
        .send({ type: 'DECREASE', reason: 'DAMAGE', items: [{ variantId, warehouseId, adjustmentQty: -1 }] })
        .expect(201),
    );
    await ctx.api().post(`/inventory/adjustments/${b.id}/approve`).expect(200);
    await ctx.api().post(`/inventory/adjustments/${b.id}/cancel`).expect(200);

    const rejected = body<{ data: Adj[] }>(
      await ctx.api().get(`/inventory/adjustments?status=REJECTED&warehouseId=${warehouseId}`).expect(200),
    );
    expect(rejected.data.map((x) => x.id)).toEqual([a.id]);
  });

  it('keeps the existing adjustment routes', async () => {
    await ctx.api().get('/inventory/adjustments/bulk').expect(400); // ParseUUIDPipe, not a lookup
    await ctx.api()
      .post('/inventory/adjustments')
      .send({ variantId, warehouseId, type: 'ADJUSTMENT_INCREASE', quantity: 1 })
      .expect(201);
    expect((await levelOf(ctx.prisma, variantId, warehouseId)).onHand).toBe(9);
  });
});
```

- [ ] **Step 8: Run e2e**

Run: `npm run test:e2e -- test/stock-adjustments.e2e-spec.ts test/rack-map.e2e-spec.ts`
Expected: PASS (rack-map still passes: bin counts still apply PENDING with `applyNow`).

- [ ] **Step 9: Commit**

```bash
git add src/modules/inventory/dto/stock-adjustment.dto.ts src/modules/inventory/stock-adjustments.* src/modules/inventory/inventory.module.ts test/stock-adjustments.e2e-spec.ts
git commit -m "feat(inventory): stock adjustment documents with approve and apply steps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Transfers API

**Files:**
- Create: `src/modules/inventory/dto/transfer.dto.ts`
- Create: `src/modules/inventory/transfers.service.ts`
- Create: `src/modules/inventory/transfers.controller.ts`
- Create: `src/modules/inventory/transfers.service.spec.ts`
- Modify: `src/modules/inventory/inventory.module.ts`
- Create: `test/transfers.e2e-spec.ts`

**Interfaces:**
- Consumes: `InventoryService.applyMovement(tx, StockChange): Promise<Movement[]>` (movements carry `unitCost`, `toLocationId`), `InventoryService.changeIncoming`; Task 1 helpers; fixtures.
- Produces: `toTransferLine(item, status)`; routes under `/inventory/transfers`.

- [ ] **Step 1: DTOs**

```ts
// src/modules/inventory/dto/transfer.dto.ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { pagination } from './inventory.dto';

/* ==========================================
   WAREHOUSE TRANSFER SCHEMAS & DTOS
   ========================================== */

export const transferStatusEnum = z.enum(['DRAFT', 'PENDING', 'IN_TRANSIT', 'PARTIAL', 'COMPLETED', 'CANCELLED']);

const transferLine = z.object({
  variantId: z.string().uuid(),
  quantity: z.number().int().positive(), // shipped in full at ship time
});
const items = z
  .array(transferLine)
  .max(200)
  .refine((l) => new Set(l.map((i) => i.variantId)).size === l.length, {
    message: 'Each variant may appear only once',
  });
const note = z.string().trim().max(1000).nullable().optional();

export const createTransferSchema = z
  .object({
    fromWarehouseId: z.string().uuid(),
    toWarehouseId: z.string().uuid(),
    note,
    items: items.default([]),
  })
  .refine((t) => t.fromWarehouseId !== t.toWarehouseId, {
    message: 'Source and destination must differ',
    path: ['toWarehouseId'],
  });

export class CreateTransferDto extends createZodDto(createTransferSchema) {}

export const updateTransferSchema = z.object({
  fromWarehouseId: z.string().uuid().optional(),
  toWarehouseId: z.string().uuid().optional(),
  note,
  items: items.optional(), // replaces every line
});

export class UpdateTransferDto extends createZodDto(updateTransferSchema) {}

export const receiveTransferSchema = z.object({
  lines: z
    .array(
      z
        .object({
          itemId: z.string().uuid(),
          receivedQty: z.number().int().nonnegative(),
          damagedQty: z.number().int().nonnegative().default(0), // → damaged bucket
          locationId: z.string().uuid().optional(), // put-away rack at the destination
        })
        .refine((l) => l.receivedQty + l.damagedQty >= 1, {
          message: 'Receive at least one unit (good or damaged)',
          path: ['receivedQty'],
        }),
    )
    .min(1)
    .max(200)
    .refine((lines) => new Set(lines.map((l) => l.itemId)).size === lines.length, {
      message: 'Each itemId may appear only once',
    }),
});

export class ReceiveTransferDto extends createZodDto(receiveTransferSchema) {}

export const transferQuerySchema = z.object({
  ...pagination,
  status: transferStatusEnum.optional(),
  fromWarehouseId: z.string().uuid().optional(),
  toWarehouseId: z.string().uuid().optional(),
  search: z.string().trim().min(1).optional(), // transfer number
});

export class TransferQueryDto extends createZodDto(transferQuerySchema) {}
```

- [ ] **Step 2: Write the failing unit tests**

```ts
// src/modules/inventory/transfers.service.spec.ts
import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { toTransferLine, TransfersService } from './transfers.service';
import { receiveTransferSchema } from './dto/transfer.dto';

const item = (o: object = {}) => ({
  id: 'ti-1',
  variantId: 'v1',
  sentQty: 4,
  receivedQty: 0,
  damagedQty: 0,
  unitCost: new Decimal(20),
  note: null,
  variant: { sku: 'SKU-1' },
  ...o,
});
const transfer = (o: object = {}) => ({
  id: 'trf-1',
  transferNumber: 'TRF-2026-00001',
  status: 'PENDING',
  fromWarehouseId: 'wh-a',
  toWarehouseId: 'wh-b',
  fromWarehouse: { code: 'A' },
  items: [item()],
  ...o,
});

function mockDb() {
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'trf-1' }]),
    $executeRaw: jest.fn(),
    inventoryTransfer: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(transfer()),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'trf-1' }),
    },
    inventoryTransferItem: { update: jest.fn(), deleteMany: jest.fn() },
    inventoryLevel: { findUnique: jest.fn().mockResolvedValue({ available: 10 }) },
    warehouse: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'wh-a', isActive: true },
        { id: 'wh-b', isActive: true },
      ]),
    },
    productVariant: { findMany: jest.fn().mockResolvedValue([{ id: 'v1' }]) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((fn: (t: typeof db) => unknown) => fn(db));
  return db;
}

describe('toTransferLine', () => {
  it('reports shippedQty only once shipped', () => {
    const v = { id: 'v1', sku: 'S', product: { name: 'P' }, optionValues: [] };
    expect(toTransferLine({ ...item(), variant: v } as never, 'PENDING')).toMatchObject({ requestedQty: 4, shippedQty: 0, outstandingQty: 0 });
    expect(toTransferLine({ ...item({ receivedQty: 1 }), variant: v } as never, 'PARTIAL')).toMatchObject({ requestedQty: 4, shippedQty: 4, outstandingQty: 3 });
  });
});

describe('receiveTransferSchema', () => {
  it('refuses the same line twice', () => {
    const line = { itemId: '0199a1b2-0000-7000-8000-000000000001', receivedQty: 1 };
    expect(receiveTransferSchema.safeParse({ lines: [line, line] }).success).toBe(false);
  });
});

describe('TransfersService', () => {
  let service: TransfersService;
  let db: ReturnType<typeof mockDb>;
  const inventory = {
    applyMovement: jest.fn().mockResolvedValue([{ unitCost: new Decimal(20), toLocationId: 'loc-in' }]),
    changeIncoming: jest.fn(),
  };

  beforeEach(async () => {
    db = mockDb();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TransfersService,
        { provide: PrismaService, useValue: db },
        { provide: InventoryService, useValue: inventory },
      ],
    }).compile();
    service = moduleRef.get(TransfersService);
    jest.spyOn(service, 'findOne').mockResolvedValue({ data: {} } as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('ship refuses short lines with a shortLines body and writes nothing', async () => {
    db.inventoryLevel.findUnique.mockResolvedValue({ available: 3 });
    const err = await service.ship('trf-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      shortLines: [{ variantId: 'v1', sku: 'SKU-1', wanted: 4, available: 3 }],
    });
    expect(inventory.applyMovement).not.toHaveBeenCalled();
  });

  it('ship books TRANSFER_OUT, keeps the cost and adds incoming at the destination', async () => {
    await service.ship('trf-1', 'u1');
    expect(inventory.applyMovement).toHaveBeenCalledWith(db, expect.objectContaining({
      variantId: 'v1',
      warehouseId: 'wh-a',
      type: 'TRANSFER_OUT',
      quantity: 4,
      referenceType: 'TRANSFER',
      referenceId: 'trf-1',
      sourceWarehouseId: 'wh-a',
      destWarehouseId: 'wh-b',
      note: 'TRF-2026-00001',
      userId: 'u1',
    }));
    expect(db.inventoryTransferItem.update).toHaveBeenCalledWith({ where: { id: 'ti-1' }, data: { unitCost: new Decimal(20) } });
    expect(inventory.changeIncoming).toHaveBeenCalledWith(db, 'v1', 'wh-b', 4);
  });

  it('receive puts damaged units into the damaged bucket at the same location', async () => {
    db.inventoryTransfer.findUniqueOrThrow.mockResolvedValue(transfer({ status: 'IN_TRANSIT' }));
    await service.receive('trf-1', { lines: [{ itemId: 'ti-1', receivedQty: 3, damagedQty: 1 }] });
    const types = inventory.applyMovement.mock.calls.map((c) => [c[1].type, c[1].quantity, c[1].locationId]);
    expect(types).toEqual([
      ['TRANSFER_IN', 3, undefined],
      ['TRANSFER_IN', 1, undefined],
      ['DAMAGED', 1, 'loc-in'],
    ]);
    expect(inventory.applyMovement.mock.calls[0][1]).toMatchObject({ unitCost: new Decimal(20), warehouseId: 'wh-b' });
    expect(inventory.changeIncoming).toHaveBeenCalledWith(db, 'v1', 'wh-b', -4);
    expect(db.inventoryTransfer.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'COMPLETED' }),
    }));
  });

  it('receive refuses more than outstanding', async () => {
    db.inventoryTransfer.findUniqueOrThrow.mockResolvedValue(transfer({ status: 'IN_TRANSIT' }));
    await expect(
      service.receive('trf-1', { lines: [{ itemId: 'ti-1', receivedQty: 5, damagedQty: 0 }] }),
    ).rejects.toThrow(BadRequestException);
    expect(inventory.applyMovement).not.toHaveBeenCalled();
  });

  it('cancel refuses a shipped transfer', async () => {
    db.inventoryTransfer.findUniqueOrThrow.mockResolvedValue(transfer({ status: 'IN_TRANSIT' }));
    await expect(service.cancel('trf-1')).rejects.toThrow(ConflictException);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/modules/inventory/transfers.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the service**

```ts
// src/modules/inventory/transfers.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma/client';
import type { TransferStatus } from 'src/generated/prisma/enums';
import { InventoryService } from './inventory.service';
import {
  assertStatus,
  lockDocument,
  nextDocumentNumber,
  pageMeta,
  runDocumentTx,
  toUserRef,
  toVariantLine,
  USER_REF_SELECT,
  VARIANT_LINE_SELECT,
  WAREHOUSE_REF_SELECT,
} from './documents.util';
import {
  CreateTransferDto,
  ReceiveTransferDto,
  TransferQueryDto,
  UpdateTransferDto,
} from './dto/transfer.dto';

const SHIPPED: TransferStatus[] = ['IN_TRANSIT', 'PARTIAL', 'COMPLETED'];

type ItemRow = Prisma.InventoryTransferItemGetPayload<{
  include: { variant: { select: typeof VARIANT_LINE_SELECT } };
}>;

/** sentQty holds the requested quantity; it counts as shipped once shipped. */
export function toTransferLine(item: ItemRow, status: TransferStatus) {
  const { sentQty, variant, ...rest } = item;
  const shippedQty = SHIPPED.includes(status) ? sentQty : 0;
  return {
    ...rest,
    variant: toVariantLine(variant),
    requestedQty: sentQty,
    shippedQty,
    outstandingQty: shippedQty ? shippedQty - item.receivedQty - item.damagedQty : 0,
  };
}

const TRANSFER_INCLUDE = {
  fromWarehouse: { select: WAREHOUSE_REF_SELECT },
  toWarehouse: { select: WAREHOUSE_REF_SELECT },
  initiatedByUser: { select: USER_REF_SELECT },
  receivedByUser: { select: USER_REF_SELECT },
  items: { orderBy: { createdAt: 'asc' }, include: { variant: { select: VARIANT_LINE_SELECT } } },
} satisfies Prisma.InventoryTransferInclude;

@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async findAll(query: TransferQueryDto) {
    const { page, limit, status, fromWarehouseId, toWarehouseId, search } = query;
    const where: Prisma.InventoryTransferWhereInput = {
      ...(status && { status }),
      ...(fromWarehouseId && { fromWarehouseId }),
      ...(toWarehouseId && { toWarehouseId }),
      ...(search && { transferNumber: { contains: search, mode: 'insensitive' } }),
    };
    const [total, rows] = await Promise.all([
      this.prisma.inventoryTransfer.count({ where }),
      this.prisma.inventoryTransfer.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          fromWarehouse: { select: WAREHOUSE_REF_SELECT },
          toWarehouse: { select: WAREHOUSE_REF_SELECT },
          initiatedByUser: { select: USER_REF_SELECT },
          items: { select: { sentQty: true, receivedQty: true, damagedQty: true } },
        },
      }),
    ]);
    return {
      data: rows.map(({ items, initiatedByUser, ...t }) => ({
        ...t,
        initiatedBy: toUserRef(initiatedByUser),
        lineCount: items.length,
        requestedUnits: items.reduce((n, i) => n + i.sentQty, 0),
        receivedUnits: items.reduce((n, i) => n + i.receivedQty, 0),
        damagedUnits: items.reduce((n, i) => n + i.damagedQty, 0),
      })),
      meta: pageMeta(total, page, limit),
    };
  }

  async findOne(id: string) {
    const t = await this.prisma.inventoryTransfer.findUnique({ where: { id }, include: TRANSFER_INCLUDE });
    if (!t) throw new NotFoundException('Transfer not found');
    const { initiatedByUser, receivedByUser, items, ...rest } = t;
    return {
      data: {
        ...rest,
        initiatedBy: toUserRef(initiatedByUser),
        receivedBy: toUserRef(receivedByUser),
        items: items.map((i) => toTransferLine(i, t.status)),
      },
    };
  }

  async create(dto: CreateTransferDto, actedBy?: string) {
    const created = await runDocumentTx(this.prisma, async (tx) => {
      await this.assertWarehouses(tx, dto.fromWarehouseId, dto.toWarehouseId);
      await this.assertVariants(tx, dto.items);
      return tx.inventoryTransfer.create({
        data: {
          transferNumber: await nextDocumentNumber(tx, 'TRF'),
          fromWarehouseId: dto.fromWarehouseId,
          toWarehouseId: dto.toWarehouseId,
          note: dto.note ?? null,
          initiatedByUserId: actedBy ?? null,
          items: { create: dto.items.map((i) => ({ variantId: i.variantId, sentQty: i.quantity })) },
        },
        select: { id: true },
      });
    });
    return this.findOne(created.id);
  }

  async update(id: string, dto: UpdateTransferDto) {
    await runDocumentTx(this.prisma, async (tx) => {
      const t = await this.lock(tx, id);
      assertStatus(t, ['DRAFT'], t.transferNumber, 'edited');
      const from = dto.fromWarehouseId ?? t.fromWarehouseId;
      const to = dto.toWarehouseId ?? t.toWarehouseId;
      await this.assertWarehouses(tx, from, to);
      if (dto.items) {
        await this.assertVariants(tx, dto.items);
        await tx.inventoryTransferItem.deleteMany({ where: { transferId: id } });
      }
      await tx.inventoryTransfer.update({
        where: { id },
        data: {
          fromWarehouseId: from,
          toWarehouseId: to,
          ...(dto.note !== undefined && { note: dto.note }),
          ...(dto.items && {
            items: { create: dto.items.map((i) => ({ variantId: i.variantId, sentQty: i.quantity })) },
          }),
        },
      });
    });
    return this.findOne(id);
  }

  async remove(id: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const t = await this.lock(tx, id);
      assertStatus(t, ['DRAFT'], t.transferNumber, 'deleted');
      await tx.inventoryTransfer.delete({ where: { id } });
    });
    return { data: { id, result: 'deleted' as const } };
  }

  async approve(id: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const t = await this.lock(tx, id);
      assertStatus(t, ['DRAFT'], t.transferNumber, 'approved');
      if (!t.items.length) throw new BadRequestException('Add at least one line before approving');
      await tx.inventoryTransfer.update({ where: { id }, data: { status: 'PENDING' } });
    });
    return this.findOne(id);
  }

  /** PENDING → IN_TRANSIT: every line ships in full or nothing ships. */
  async ship(id: string, actedBy?: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const t = await this.lock(tx, id);
      assertStatus(t, ['PENDING'], t.transferNumber, 'shipped');
      await this.assertWarehouses(tx, t.fromWarehouseId, t.toWarehouseId);

      const shortLines: { variantId: string; sku: string; wanted: number; available: number }[] = [];
      for (const i of t.items) {
        const level = await tx.inventoryLevel.findUnique({
          where: { variantId_warehouseId: { variantId: i.variantId, warehouseId: t.fromWarehouseId } },
          select: { available: true },
        });
        const available = level?.available ?? 0;
        if (available < i.sentQty) {
          shortLines.push({ variantId: i.variantId, sku: i.variant.sku, wanted: i.sentQty, available });
        }
      }
      if (shortLines.length) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: `${shortLines.length} line(s) don't have enough available stock at ${t.fromWarehouse.code}`,
          shortLines,
        });
      }

      for (const i of t.items) {
        // applyMovement re-checks availability under the level lock.
        const [movement] = await this.inventory.applyMovement(tx, {
          variantId: i.variantId,
          warehouseId: t.fromWarehouseId,
          type: 'TRANSFER_OUT',
          quantity: i.sentQty,
          referenceType: 'TRANSFER',
          referenceId: t.id,
          sourceWarehouseId: t.fromWarehouseId,
          destWarehouseId: t.toWarehouseId,
          note: t.transferNumber,
          userId: actedBy,
        });
        // The source's average cost travels with the units.
        await tx.inventoryTransferItem.update({ where: { id: i.id }, data: { unitCost: movement.unitCost } });
        await this.inventory.changeIncoming(tx, i.variantId, t.toWarehouseId, i.sentQty);
      }
      await tx.inventoryTransfer.update({ where: { id }, data: { status: 'IN_TRANSIT', shippedAt: new Date() } });
    });
    return this.findOne(id);
  }

  async receive(id: string, dto: ReceiveTransferDto, actedBy?: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const t = await this.lock(tx, id);
      assertStatus(t, ['IN_TRANSIT', 'PARTIAL'], t.transferNumber, 'received');

      const byId = new Map(t.items.map((i) => [i.id, i]));
      const left = (i: { sentQty: number; receivedQty: number; damagedQty: number }) =>
        i.sentQty - i.receivedQty - i.damagedQty;
      for (const line of dto.lines) {
        const item = byId.get(line.itemId);
        if (!item) throw new BadRequestException(`Line ${line.itemId} is not on ${t.transferNumber}`);
        if (line.receivedQty + line.damagedQty > left(item)) {
          throw new BadRequestException(
            `${item.variant.sku}: ${left(item)} outstanding, ${line.receivedQty + line.damagedQty} received`,
          );
        }
      }

      const base = {
        warehouseId: t.toWarehouseId,
        referenceType: 'TRANSFER' as const,
        referenceId: t.id,
        sourceWarehouseId: t.fromWarehouseId,
        destWarehouseId: t.toWarehouseId,
        userId: actedBy,
      };
      for (const line of dto.lines) {
        const item = byId.get(line.itemId)!;
        if (line.receivedQty > 0) {
          await this.inventory.applyMovement(tx, {
            ...base,
            variantId: item.variantId,
            locationId: line.locationId,
            type: 'TRANSFER_IN',
            quantity: line.receivedQty,
            unitCost: item.unitCost,
            note: t.transferNumber,
          });
        }
        if (line.damagedQty > 0) {
          // Arrived damaged: in, then straight to the damaged bucket from
          // wherever it was put, so it stays on the ledger.
          const [arrived] = await this.inventory.applyMovement(tx, {
            ...base,
            variantId: item.variantId,
            locationId: line.locationId,
            type: 'TRANSFER_IN',
            quantity: line.damagedQty,
            unitCost: item.unitCost,
            note: t.transferNumber,
          });
          await this.inventory.applyMovement(tx, {
            ...base,
            variantId: item.variantId,
            locationId: arrived.toLocationId,
            type: 'DAMAGED',
            quantity: line.damagedQty,
            note: `${t.transferNumber}: damaged in transit`,
          });
        }
        await this.inventory.changeIncoming(tx, item.variantId, t.toWarehouseId, -(line.receivedQty + line.damagedQty));
        const receivedQty = item.receivedQty + line.receivedQty;
        const damagedQty = item.damagedQty + line.damagedQty;
        await tx.inventoryTransferItem.update({ where: { id: item.id }, data: { receivedQty, damagedQty } });
        byId.set(item.id, { ...item, receivedQty, damagedQty });
      }

      const done = [...byId.values()].every((i) => left(i) === 0);
      await tx.inventoryTransfer.update({
        where: { id },
        data: done
          ? { status: 'COMPLETED', receivedAt: new Date(), receivedByUserId: actedBy ?? null }
          : { status: 'PARTIAL' },
      });
    });
    return this.findOne(id);
  }

  async cancel(id: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const t = await this.lock(tx, id);
      if (SHIPPED.includes(t.status)) {
        throw new ConflictException(`${t.transferNumber} has shipped and can't be cancelled; receive it instead`);
      }
      assertStatus(t, ['DRAFT', 'PENDING'], t.transferNumber, 'cancelled');
      await tx.inventoryTransfer.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    });
    return this.findOne(id);
  }

  // ─── Helpers ────────────────────────────────────

  private async lock(tx: Prisma.TransactionClient, id: string) {
    if (!(await lockDocument(tx, 'inventory_transfers', id))) {
      throw new NotFoundException('Transfer not found');
    }
    return tx.inventoryTransfer.findUniqueOrThrow({
      where: { id },
      include: {
        fromWarehouse: { select: { code: true } },
        items: { orderBy: { createdAt: 'asc' }, include: { variant: { select: { sku: true } } } },
      },
    });
  }

  private async assertWarehouses(tx: Prisma.TransactionClient, from: string, to: string) {
    if (from === to) throw new BadRequestException('Source and destination must differ');
    const found = await tx.warehouse.findMany({ where: { id: { in: [from, to] } }, select: { id: true, isActive: true } });
    for (const id of [from, to]) {
      const w = found.find((x) => x.id === id);
      if (!w || !w.isActive) throw new BadRequestException(`Warehouse "${id}" not found or inactive`);
    }
  }

  private async assertVariants(tx: Prisma.TransactionClient, items: { variantId: string }[]) {
    if (!items.length) return;
    const ids = items.map((i) => i.variantId);
    const found = await tx.productVariant.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const missing = ids.find((id) => !found.some((v) => v.id === id));
    if (missing) throw new BadRequestException(`Variant "${missing}" not found`);
  }
}
```

- [ ] **Step 5: Controller and module**

```ts
// src/modules/inventory/transfers.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { TransfersService } from './transfers.service';
import {
  CreateTransferDto,
  ReceiveTransferDto,
  TransferQueryDto,
  UpdateTransferDto,
} from './dto/transfer.dto';

/** Warehouse → warehouse transfers (ADMIN+). `actedBy` is only recorded. */
@Controller('inventory/transfers')
@UsePipes(ZodValidationPipe)
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  findAll(@Query() query: TransferQueryDto) {
    return this.transfers.findAll(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateTransferDto, @Query('actedBy') actedBy?: string) {
    return this.transfers.create(dto, actedBy);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.findOne(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTransferDto) {
    return this.transfers.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.remove(id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.approve(id);
  }

  @Post(':id/ship')
  @HttpCode(HttpStatus.OK)
  ship(@Param('id', ParseUUIDPipe) id: string, @Query('actedBy') actedBy?: string) {
    return this.transfers.ship(id, actedBy);
  }

  @Post(':id/receive')
  @HttpCode(HttpStatus.OK)
  receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveTransferDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.transfers.receive(id, dto, actedBy);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.cancel(id);
  }
}
```

Register in `inventory.module.ts`.

- [ ] **Step 6: Run unit tests**

Run: `npx jest src/modules/inventory`
Expected: PASS.

- [ ] **Step 7: E2E**

```ts
// test/transfers.e2e-spec.ts
import { bootApp, body, createVariant, createWarehouse, levelOf, runTag, stockIn } from './inventory-fixtures';

const RUN = runTag();
type Trf = {
  id: string;
  transferNumber: string;
  status: string;
  items: { id: string; requestedQty: number; shippedQty: number; receivedQty: number; damagedQty: number; unitCost: string | null }[];
};
const data = <T>(res: Parameters<typeof body>[0]) => body<{ data: T }>(res).data;

describe('Transfers (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  let fromId: string;
  let toId: string;
  let variantId: string;

  beforeAll(async () => {
    ctx = await bootApp();
    fromId = (await createWarehouse(ctx.prisma, RUN, 'T1')).id;
    toId = (await createWarehouse(ctx.prisma, RUN, 'T2')).id;
    variantId = (await createVariant(ctx.prisma, RUN, 'TRF1')).id;
    await stockIn(ctx.prisma, ctx.inventory, variantId, fromId, 10, 20);
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.prisma.$disconnect();
  });

  const draft = async (quantity: number) =>
    data<Trf>(
      await ctx.api()
        .post('/inventory/transfers')
        .send({ fromWarehouseId: fromId, toWarehouseId: toId, items: [{ variantId, quantity }] })
        .expect(201),
    );

  it('approve → ship → receive with a damaged unit', async () => {
    const t = await draft(4);
    expect(t.items[0]).toMatchObject({ requestedQty: 4, shippedQty: 0 });
    await ctx.api().post(`/inventory/transfers/${t.id}/ship`).expect(409); // still DRAFT
    await ctx.api().post(`/inventory/transfers/${t.id}/approve`).expect(200);

    const shipped = data<Trf>(await ctx.api().post(`/inventory/transfers/${t.id}/ship`).expect(200));
    expect(shipped.status).toBe('IN_TRANSIT');
    expect(shipped.items[0]).toMatchObject({ shippedQty: 4 });
    expect(Number(shipped.items[0].unitCost)).toBe(20);
    expect((await levelOf(ctx.prisma, variantId, fromId)).onHand).toBe(6);
    expect((await levelOf(ctx.prisma, variantId, toId)).incoming).toBe(4);
    await ctx.api().post(`/inventory/transfers/${t.id}/cancel`).expect(409);

    const done = data<Trf>(
      await ctx.api()
        .post(`/inventory/transfers/${t.id}/receive`)
        .send({ lines: [{ itemId: t.items[0].id, receivedQty: 3, damagedQty: 1 }] })
        .expect(200),
    );
    expect(done.status).toBe('COMPLETED');
    const dest = await levelOf(ctx.prisma, variantId, toId);
    expect(dest).toMatchObject({ onHand: 3, damaged: 1, incoming: 0 });
    expect(Number(dest.unitCost)).toBe(20);
    expect((await ctx.prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock).toBe(9);

    const types = (
      await ctx.prisma.inventoryMovement.findMany({
        where: { referenceType: 'TRANSFER', referenceId: t.id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((m) => [m.type, m.quantity]);
    expect(types).toEqual([
      ['TRANSFER_OUT', 4],
      ['TRANSFER_IN', 3],
      ['TRANSFER_IN', 1],
      ['DAMAGED', 1],
    ]);
  });

  it('a short ship is refused with shortLines and changes nothing', async () => {
    const t = await draft(100);
    await ctx.api().post(`/inventory/transfers/${t.id}/approve`).expect(200);
    const res = await ctx.api().post(`/inventory/transfers/${t.id}/ship`).expect(409);
    expect(body<{ shortLines: unknown[] }>(res).shortLines).toEqual([
      { variantId, sku: `E2E-${RUN}-TRF1`, wanted: 100, available: 6 },
    ]);
    expect((await levelOf(ctx.prisma, variantId, fromId)).onHand).toBe(6);
    const cancelled = data<Trf>(await ctx.api().post(`/inventory/transfers/${t.id}/cancel`).expect(200));
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('refuses the same warehouse on both ends', async () => {
    await ctx.api()
      .post('/inventory/transfers')
      .send({ fromWarehouseId: fromId, toWarehouseId: fromId, items: [] })
      .expect(400);
  });
});
```

- [ ] **Step 8: Run e2e**

Run: `npm run test:e2e -- test/transfers.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/modules/inventory/dto/transfer.dto.ts src/modules/inventory/transfers.* src/modules/inventory/inventory.module.ts test/transfers.e2e-spec.ts
git commit -m "feat(inventory): warehouse transfers API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Revalue stock on hand

**Files:**
- Modify: `prisma/inventory.prisma` (`enum MovementType`)
- Create: `prisma/migrations/20261007120000_revaluation_movement/migration.sql`
- Regenerate: `src/generated/prisma/**`
- Modify: `src/modules/inventory/inventory.service.ts` (`MOVEMENT_DIRECTION`, new `revalue`)
- Modify: `src/modules/inventory/dto/inventory.dto.ts` (`movementTypeEnum`, `RevalueDto`)
- Modify: `src/modules/inventory/inventory.controller.ts`
- Test: `src/modules/inventory/inventory.service.spec.ts`, `test/revalue.e2e-spec.ts`

**Interfaces:**
- Produces: `InventoryService.revalue(levelId: string, dto: RevalueDto, actedBy?: string): Promise<{ data: { id; variantId; warehouseId; onHand; unitCost; totalCost } }>`; route `POST /inventory/levels/:levelId/revalue`.

- [ ] **Step 1: Schema + migration**

In `prisma/inventory.prisma` `enum MovementType`, after `LOCATION_MOVE`:

```prisma

  // Unit cost corrected for stock already on hand (direction INTERNAL —
  // onHand unchanged; quantity = units revalued, metadata.previousUnitCost)
  REVALUATION
```

```sql
-- prisma/migrations/20261007120000_revaluation_movement/migration.sql
-- AlterEnum
ALTER TYPE "MovementType" ADD VALUE 'REVALUATION';
```

Run: `npx prisma generate`
Expected: client regenerated; `src/generated/prisma/enums.ts` contains `REVALUATION`.

- [ ] **Step 2: Write the failing unit tests**

Add to `inventory.service.spec.ts` (inside `describe('InventoryService')`; add `findUniqueOrThrow: jest.fn((a: { where: { id: string } }) => ({ id: a.where.id }))` to the mock's `tx.inventoryLevel`):

```ts
  describe('revalue', () => {
    it('sets the cost and writes a REVALUATION audit row', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 6, unitCost: new Decimal(0) })]);

      await service.revalue('level-1', { unitCost: 45.5, note: 'Supplier invoice' }, 'admin-1');

      expect(callArg<{ data: object }>(tx.inventoryLevel.update).data).toMatchObject({
        unitCost: new Decimal(45.5),
        totalCost: new Decimal(273),
      });
      expect(callArg<{ data: object }>(tx.inventoryMovement.create).data).toMatchObject({
        type: 'REVALUATION',
        direction: 'INTERNAL',
        quantity: 6,
        onHandBefore: 6,
        onHandAfter: 6,
        note: 'Supplier invoice',
        performedByUserId: 'admin-1',
        metadata: { previousUnitCost: '0' },
      });
    });

    it('refuses a level with nothing on hand', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 0 })]);
      await expect(service.revalue('level-1', { unitCost: 10 })).rejects.toThrow(BadRequestException);
      expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/modules/inventory/inventory.service.spec.ts -t revalue`
Expected: FAIL — `service.revalue is not a function`.

- [ ] **Step 4: Implement**

`MOVEMENT_DIRECTION` — add `REVALUATION: 'INTERNAL',` after `LOCATION_MOVE: 'INTERNAL',` (the `Record<MovementType, …>` type forces it after `prisma generate`).

`dto/inventory.dto.ts` — add `'REVALUATION',` to the end of `movementTypeEnum`, and:

```ts
// Correct the unit cost of stock already on hand (no quantity change).
export const revalueSchema = z.object({
  unitCost: z.number().nonnegative(),
  note,
});

export class RevalueDto extends createZodDto(revalueSchema) {}
```

`InventoryService` — add under ADMIN WRITES:

```ts
  /**
   * POST /inventory/levels/:id/revalue — sets the average cost of the
   * units on hand (e.g. stock booked at ৳0). onHand is unchanged; one
   * REVALUATION ledger row records the old and new cost.
   */
  async revalue(levelId: string, dto: RevalueDto, actedBy?: string) {
    const level = await this.runInTransaction(async (tx) => {
      const current = await this.lockLevelById(tx, levelId);
      if (current.onHand === 0) {
        throw new BadRequestException(
          'Nothing on hand to revalue; the next receipt sets the cost',
        );
      }
      const unitCost = new Decimal(dto.unitCost).toDecimalPlaces(4);
      const totalCost = unitCost.mul(current.onHand);
      await tx.inventoryLevel.update({
        where: { id: levelId },
        data: { unitCost, totalCost, version: { increment: 1 } },
      });
      await tx.inventoryMovement.create({
        data: {
          inventoryLevelId: levelId,
          type: 'REVALUATION',
          direction: 'INTERNAL',
          quantity: current.onHand,
          onHandBefore: current.onHand,
          onHandAfter: current.onHand,
          unitCost,
          totalCost,
          note: dto.note ?? null,
          performedByUserId: actedBy ?? null,
          metadata: { previousUnitCost: new Decimal(current.unitCost).toString() },
        },
      });
      return tx.inventoryLevel.findUniqueOrThrow({
        where: { id: levelId },
        select: { id: true, variantId: true, warehouseId: true, onHand: true, unitCost: true, totalCost: true },
      });
    });
    return { data: level };
  }
```

(import `RevalueDto` from `./dto/inventory.dto`).

`inventory.controller.ts` — add (import `ParseUUIDPipe`, `RevalueDto`):

```ts
  // ── POST /inventory/levels/:levelId/revalue (ADMIN+) ──
  // Fixes the cost of stock already on hand; quantities don't change.
  @Post('levels/:levelId/revalue')
  @HttpCode(HttpStatus.OK)
  revalue(
    @Param('levelId', ParseUUIDPipe) levelId: string,
    @Body() dto: RevalueDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.inventoryService.revalue(levelId, dto, actedBy);
  }
```

- [ ] **Step 5: Run unit tests**

Run: `npx jest src/modules/inventory`
Expected: PASS.

- [ ] **Step 6: E2E**

```ts
// test/revalue.e2e-spec.ts
import { bootApp, body, createVariant, createWarehouse, levelOf, runTag, stockIn } from './inventory-fixtures';

const RUN = runTag();

describe('Revalue (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (ctx = await bootApp()));
  afterAll(async () => {
    await ctx.app.close();
    await ctx.prisma.$disconnect();
  });

  it('sets the cost of stock on hand and audits it', async () => {
    const warehouseId = (await createWarehouse(ctx.prisma, RUN, 'RV')).id;
    const variantId = (await createVariant(ctx.prisma, RUN, 'RV1')).id;
    await stockIn(ctx.prisma, ctx.inventory, variantId, warehouseId, 6, 0);
    const level = await levelOf(ctx.prisma, variantId, warehouseId);

    const res = await ctx.api()
      .post(`/inventory/levels/${level.id}/revalue`)
      .send({ unitCost: 45.5, note: 'Fix opening cost' })
      .expect(200);
    expect(Number(body<{ data: { totalCost: string } }>(res).data.totalCost)).toBe(273);

    const after = await levelOf(ctx.prisma, variantId, warehouseId);
    expect(after.onHand).toBe(6);
    expect(Number(after.unitCost)).toBe(45.5);

    const movements = body<{ data: { type: string }[] }>(
      await ctx.api().get(`/inventory/movements?variantId=${variantId}&type=REVALUATION`).expect(200),
    );
    expect(movements.data).toHaveLength(1);
  });
});
```

- [ ] **Step 7: Run e2e and the full suites**

Run: `npm run test:e2e -- test/revalue.e2e-spec.ts` then `npm run test` and `npm run test:e2e`
Expected: all PASS (global setup applies the new migration to the test DB).

- [ ] **Step 8: Commit**

```bash
git add prisma/inventory.prisma prisma/migrations/20261007120000_revaluation_movement src/generated/prisma src/modules/inventory/inventory.service.ts src/modules/inventory/inventory.service.spec.ts src/modules/inventory/dto/inventory.dto.ts src/modules/inventory/inventory.controller.ts test/revalue.e2e-spec.ts
git commit -m "feat(inventory): revalue stock on hand with a REVALUATION ledger entry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: API reference

**Files:**
- Create: `docs/api/inventory-workflows.md`

**Interfaces:**
- Consumes: the routes and shapes from Tasks 3–7 (read the controllers and DTOs; copy field names exactly).

- [ ] **Step 1: Write the doc** with these sections, in this order, each concrete (real JSON from a local run of the e2e flows is the easiest source of examples):
  1. **Conventions** — `{ data }` / `{ data, meta }` with a `meta` example; errors `{ statusCode, message, error }`; 409 on a wrong transition (example message `"PO-2026-00001 is RECEIVED and can't be edited"`); `?actedBy=<userId>` optional, recorded only, no auth yet (ADMIN+ by route comment); `:id` must be a UUID (400 otherwise); line display fields `variant { id, sku, productName, label }`, `warehouse { id, code, name }`, `location { id, code } | null`, users `{ id, name } | null`; ledger rows carry `referenceType`/`referenceId` and a note starting with the document number; `incoming` rules (submit +ordered; PO receive −(good+damaged); PO cancel/close −outstanding; transfer ship +sent at destination; transfer receive −(good+damaged)).
  2. **Warehouses** — route table (method, path, body, response, errors) for all six routes; editable fields; `counts` object; default/active rules; delete rules.
  3. **Purchase orders** — status diagram `DRAFT → SUBMITTED → CONFIRMED → PARTIAL → RECEIVED → CLOSED`, `CANCELLED` from DRAFT/SUBMITTED/CONFIRMED, `CLOSED` from PARTIAL/RECEIVED; the UI button → route mapping (Save → PATCH, Submit, Mark confirmed, Receive, Cancel, Cancel the rest / Close short → close, Delete draft); create/update/receive bodies; per-line `outstandingQty`; `metadata.source = "REORDER_RULE"` note; supplier route.
  4. **Stock adjustments** — diagram `PENDING → APPROVED → APPLIED`, `REJECTED` from PENDING, `CANCELLED` from PENDING/APPROVED; line rules per type (signed `adjustmentQty`, `actualQty` for counts, server `expectedQty`); re-base at apply; difference from the direct `POST /inventory/adjustments`; rack-map counts appear here.
  5. **Transfers** — diagram `DRAFT → PENDING → IN_TRANSIT → PARTIAL → COMPLETED`, `CANCELLED` from DRAFT/PENDING; line fields `requestedQty/shippedQty/receivedQty/damagedQty/outstandingQty`; the 409 `shortLines` body verbatim; damaged-on-receipt ledger (`TRANSFER_IN` + `DAMAGED`).
  6. **Revalue** — route, body, response, 400 on `onHand = 0`, `REVALUATION` movement fields.

- [ ] **Step 2: Check every path in the doc against the controllers**

Run: `grep -rhoE "@(Get|Post|Patch|Delete)\('[^']*'\)" src/modules/inventory/{warehouses,purchase-orders,stock-adjustments,transfers}.controller.ts src/modules/inventory/inventory.controller.ts`
Expected: every route listed appears in the doc.

- [ ] **Step 3: Commit**

```bash
git add docs/api/inventory-workflows.md
git commit -m "docs(inventory): API reference for warehouse, PO, adjustment and transfer workflows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Frontend hookup prompt

**Files:**
- Create: `docs/frontend/inventory-workflows-prompt.md`

- [ ] **Step 1: Write the prompt file** with exactly this content:

````markdown
# Prompt: hook the admin inventory pages up to the backend

You're working in `ecomerce-admin` (Next.js 16, React 19, server actions,
shadcn, react-hook-form + zod). Read `CLAUDE.md` / `AGENTS.md` there first.

## Goal

Replace the demo data on four pages with the real backend. The API
reference is `ecomerce-backend/docs/api/inventory-workflows.md`; read it
before writing code, and treat it as the source of truth for paths, bodies
and response shapes.

In scope (and only these):
- `app/(admin)/inventory/setup/warehouses/page.tsx` (+ `[warehouseId]`) → `components/inventory/setup.tsx`
- `app/(admin)/inventory/purchase-orders/page.tsx` → `components/inventory/purchase-orders.tsx`
- `app/(admin)/inventory/adjustments/page.tsx` → `components/inventory/adjustments.tsx`
- `app/(admin)/inventory/transfers/page.tsx` → `components/inventory/transfers.tsx`

Out of scope: batches, reservations, alerts and reorder rules keep using
`lib/inventory-demo.ts` and their `DemoNote`. Don't delete the demo types
those pages still import.

## How to do it

1. Follow the existing patterns exactly: `lib/api.ts` for requests,
   `lib/action-response.ts` for action results, `app/actions/inventory.actions.ts`
   and `supplier.actions.ts` for server actions, `types/*.type.ts` for types.
   Add `app/actions/warehouse.actions.ts`, `purchase-order.actions.ts`,
   `adjustment.actions.ts`, `transfer.actions.ts`, and types in
   `types/warehouse.type.ts`, `purchase-order.type.ts`, `adjustment.type.ts`,
   `transfer.type.ts`. Revalidate the page path after each write.
2. New endpoints return `{ data }` (one) or `{ data, meta }` (list).
   Decimals (`unitCost`, `totalCost`, `subtotalAmount`, `taxAmount`,
   `shippingAmount`, `totalAmount`, `stockValue`) arrive as strings — convert
   with `Number()` for display and send numbers back.
3. Map the API shapes to what the components render at the boundary
   (a small `toView` per type), so component internals change as little as
   possible. Display fields on every line: `variant { sku, productName, label }`,
   `warehouse { code, name }`, `location { code } | null`; users are
   `{ id, name } | null`.
4. Remove the `DemoNote` and the `DEMO_*` import from each of the four pages
   once it's wired. Server pages fetch with the actions; keep `connection()`.
5. There's no login yet: don't send `actedBy`, don't hide buttons by role.

## Button → endpoint map

**Warehouses** (`/inventory/warehouses`)
- List: `GET /inventory/warehouses` — use it instead of deriving warehouse
  ids from racks (`getLocations`). Show `counts.locations`,
  `counts.variantsStocked`, `counts.unitsOnHand`, `counts.stockValue` (৳).
- Create: `POST` with `code, name, type, addressLine1, addressLine2, city, state, postalCode, priority, isDefault, isActive`.
- Edit: `PATCH /:id` with the same fields **except `code`** (read-only after
  create; the API rejects it).
- Delete: `DELETE /:id`. On 409 show the message ("…Deactivate it instead.")
  and offer the Active toggle.
- Errors to surface as toasts: 400 "Make another warehouse the default
  instead", 400 "The default warehouse can't be inactive", 409 open
  documents on deactivate.
- Detail page: `GET /:id` and `GET /:id/stock?page=&limit=&search=`.

**Purchase orders** (`/purchase-orders`)
- List: `GET /purchase-orders?status=&supplierId=&search=&page=&limit=`.
- Detail: `GET /purchase-orders/:id`.
- New / Save (DRAFT): `POST` / `PATCH /:id` with `supplierId, expectedAt, note, taxAmount, shippingAmount, items[{ variantId, warehouseId, orderedQty, unitCost }]`.
  Totals come back computed; display them, don't compute your own.
- Delete draft: `DELETE /:id`.
- Submit: `POST /:id/submit`. Mark confirmed: `POST /:id/confirm`.
- Receive dialog: `POST /:id/receive` with `{ lines: [{ itemId, quantity, damagedQty }] }`
  from the Good/Damaged inputs; cap inputs at each line's `outstandingQty`.
- Cancel: `POST /:id/cancel` (only offered with nothing received).
- "Cancel the rest" and "Close short" on a PARTIAL PO: both `POST /:id/close`.
- "From a reorder rule" badge: `metadata?.source === 'REORDER_RULE'`.

**Adjustments** (`/inventory/adjustments`)
- List: `GET /inventory/adjustments?status=&type=&reason=&warehouseId=`.
- New / Save (PENDING): `POST /inventory/adjustments/requests` /
  `PATCH /inventory/adjustments/:id` with `type` (create only), `reason`, `note`,
  `items[{ variantId, warehouseId, locationId?, actualQty?, adjustmentQty? }]`.
  INCREASE sends a positive `adjustmentQty`, DECREASE a **negative** one,
  CYCLE_COUNT sends `actualQty`. `expectedQty` is filled by the server:
  show it read-only.
- PENDING buttons: Save, Approve (`POST /:id/approve`), Reject (`POST /:id/reject`), Cancel (`POST /:id/cancel`).
- APPROVED buttons: "Apply to stock" (`POST /:id/apply`), Cancel.
  A 400 from apply ("Not enough stock…") leaves it APPROVED — show the message.
- Don't touch the existing stock-sheet calls to `POST /inventory/adjustments`
  and `/adjustments/bulk`; they stay as they are.

**Transfers** (`/inventory/transfers`)
- List: `GET /inventory/transfers?status=&fromWarehouseId=&toWarehouseId=`.
- New / Save (DRAFT): `POST` / `PATCH /:id` with `fromWarehouseId, toWarehouseId, note, items[{ variantId, quantity }]`.
- Delete draft: `DELETE /:id`. Approve: `POST /:id/approve`.
- Ship: `POST /:id/ship`. On 409 the body has
  `shortLines: [{ variantId, sku, wanted, available }]` — show them in the
  dialog (e.g. "SKU-1: wanted 100, available 6") and keep the transfer open.
- Receive dialog: `POST /:id/receive` with `{ lines: [{ itemId, receivedQty, damagedQty }] }`; cap at `outstandingQty`.
- Cancel: `POST /:id/cancel` (DRAFT/PENDING only).
- Lines show `requestedQty`, `shippedQty`, `receivedQty`, `damagedQty`.

**Movements page**
- Add a label for the new movement type `REVALUATION` ("Revaluation",
  neutral/internal styling) wherever movement types are mapped to labels.
- Rows with `referenceType` PURCHASE_ORDER / TRANSFER / ADJUSTMENT have a
  `note` starting with the document number — show it as the reference.

**Optional: Revalue** — on the stock sheet, a "Set unit cost" action can
call `POST /inventory/levels/:levelId/revalue { unitCost, note }` (400 when
nothing is on hand). Only add it if it fits the existing sheet.

## Done when

- The four pages load, create, edit and run every workflow button against a
  running backend (`npm run start:dev` in `ecomerce-backend`), with errors
  shown as toasts.
- `npm run lint` and `npm run build` pass in `ecomerce-admin`.
- The other inventory pages are unchanged.
````

- [ ] **Step 2: Commit**

```bash
git add docs/frontend/inventory-workflows-prompt.md
git commit -m "docs(inventory): prompt for wiring the admin pages to the new APIs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Final verification

- [ ] **Step 1:** `npm run lint` — Expected: no errors (fix any in files from this plan).
- [ ] **Step 2:** `npm run build` — Expected: compiles.
- [ ] **Step 3:** `npm run test` — Expected: all unit suites pass.
- [ ] **Step 4:** `npm run test:e2e` — Expected: all e2e suites pass, including `rack-map` and `app`.
- [ ] **Step 5:** Commit any lint/format fixes:

```bash
git add -A src test
git commit -m "chore(inventory): lint fixes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
