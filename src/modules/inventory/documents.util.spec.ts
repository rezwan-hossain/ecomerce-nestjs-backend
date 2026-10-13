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
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'po-1' }])
      .mockResolvedValueOnce([]);
    await expect(
      lockDocument(asTx(tx), 'purchase_orders', 'po-1'),
    ).resolves.toBe(true);
    await expect(
      lockDocument(asTx(tx), 'purchase_orders', 'po-2'),
    ).resolves.toBe(false);
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
      assertStatus(
        { status: 'RECEIVED' },
        ['DRAFT'],
        'PO-2026-00001',
        'edited',
      ),
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
    ).toEqual({
      id: 'v1',
      sku: 'TEE-RED-XL',
      productName: 'Tee',
      label: 'Red / XL',
    });
  });
});

describe('toUserRef', () => {
  const base = {
    id: 'u1',
    firstName: null,
    lastName: null,
    userName: null,
    email: 'a@b.c',
  };
  it('prefers the full name, then userName, then email', () => {
    expect(
      toUserRef({ ...base, firstName: 'Nusrat', lastName: 'Jahan' }),
    ).toEqual({ id: 'u1', name: 'Nusrat Jahan' });
    expect(toUserRef({ ...base, userName: 'nusrat' })).toEqual({
      id: 'u1',
      name: 'nusrat',
    });
    expect(toUserRef(base)).toEqual({ id: 'u1', name: 'a@b.c' });
    expect(toUserRef(null)).toBeNull();
  });
});

describe('pageMeta', () => {
  it('never reports zero pages', () => {
    expect(pageMeta(0, 1, 20)).toEqual({
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
    expect(pageMeta(41, 2, 20)).toEqual({
      total: 41,
      page: 2,
      limit: 20,
      totalPages: 3,
    });
  });
});
