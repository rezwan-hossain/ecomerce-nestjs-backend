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
