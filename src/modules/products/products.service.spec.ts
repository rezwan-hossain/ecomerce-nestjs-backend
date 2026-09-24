import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { AddVariantDto } from './dto/product-variant.dto';

/** A fresh, fully-mocked PrismaService. $transaction just invokes the
 * callback with the same mock, so `tx.x` and `prisma.x` hit the same spies. */
function createMockPrisma() {
  const models = {
    product: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    productVariant: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    productImage: {
      count: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    productCategory: { createMany: jest.fn(), deleteMany: jest.fn() },
    productTag: { createMany: jest.fn(), deleteMany: jest.fn() },
    productOption: { createMany: jest.fn(), findMany: jest.fn() },
    variantOptionValue: { createMany: jest.fn() },
    variantImage: { createMany: jest.fn() },
    brand: { findUnique: jest.fn() },
    category: { count: jest.fn() },
    tag: { count: jest.fn() },
    option: { count: jest.fn() },
    optionValue: { findMany: jest.fn() },
  };

  const $transaction = jest.fn((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof models) => unknown)(models);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });

  return { ...models, $transaction };
}

type MockPrisma = ReturnType<typeof createMockPrisma>;

/** Typed access to a mock's call args, avoiding the `any` that
 * expect.objectContaining()'s typings produce when nested. */
function firstCallArg<T>(mockFn: jest.Mock): T {
  const args = mockFn.mock.calls[0] as unknown[];
  return args[0] as T;
}

function baseVariant(overrides: Partial<AddVariantDto> = {}) {
  return {
    sku: 'SKU-1',
    price: 100,
    stock: 10,
    isActive: true,
    ...overrides,
  };
}

function baseCreateDto(
  overrides: Partial<CreateProductDto> = {},
): CreateProductDto {
  return {
    name: 'Test Product',
    variants: [baseVariant()],
    ...overrides,
  } as CreateProductDto;
}

describe('ProductsService', () => {
  let service: ProductsService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ═════════════════════════════════════════════════
  //   createProduct — slug resolution
  // ═════════════════════════════════════════════════

  describe('createProduct — slug resolution', () => {
    it('rejects an explicit slug that is already taken', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: 'existing-id' });

      await expect(
        service.createProduct(baseCreateDto({ slug: 'taken-slug' })),
      ).rejects.toThrow(ConflictException);

      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it('derives the slug from the name when none is provided', async () => {
      prisma.product.findUnique.mockResolvedValue(null); // no collision
      prisma.productVariant.findMany.mockResolvedValue([]); // SKU check
      prisma.product.create.mockResolvedValue({ id: 'p1' });
      prisma.product.findUnique.mockResolvedValueOnce(null); // slug check itself
      prisma.product.findUnique.mockResolvedValue(null);

      await service.createProduct(baseCreateDto({ name: 'My Cool Product' }));

      const { data } = firstCallArg<{ data: { slug: string } }>(
        prisma.product.create,
      );
      expect(data.slug).toBe('my-cool-product');
    });

    it('falls back to a UUID-suffixed slug when the derived slug collides', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: 'existing-id' }); // slug taken
      prisma.productVariant.findMany.mockResolvedValue([]);
      prisma.product.create.mockResolvedValue({ id: 'p1' });

      await service.createProduct(baseCreateDto({ name: 'Duplicate Name' }));

      const { data } = firstCallArg<{ data: { slug: string } }>(
        prisma.product.create,
      );
      expect(data.slug).toMatch(/^duplicate-name-[a-f0-9]{4}$/);
    });
  });

  // ═════════════════════════════════════════════════
  //   createProduct — cross-entity validation
  // ═════════════════════════════════════════════════

  describe('createProduct — validation', () => {
    beforeEach(() => {
      prisma.product.findUnique.mockResolvedValue(null);
      prisma.productVariant.findMany.mockResolvedValue([]);
    });

    it('rejects when primaryCategoryId is not included in categoryIds', async () => {
      prisma.category.count.mockResolvedValue(1);

      await expect(
        service.createProduct(
          baseCreateDto({
            categoryIds: ['cat-1'],
            primaryCategoryId: 'cat-2',
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a brand that does not exist', async () => {
      prisma.brand.findUnique.mockResolvedValue(null);

      await expect(
        service.createProduct(baseCreateDto({ brandId: 'missing-brand' })),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects duplicate SKUs against existing variants', async () => {
      prisma.productVariant.findMany.mockResolvedValue([{ sku: 'SKU-1' }]);

      await expect(service.createProduct(baseCreateDto())).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects when options are declared but a variant has no optionValueIds', async () => {
      prisma.option.count.mockResolvedValue(1);

      await expect(
        service.createProduct(
          baseCreateDto({
            optionIds: ['opt-1'],
            variants: [baseVariant({ optionValueIds: undefined })],
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ═════════════════════════════════════════════════
  //   validateOptionValueIds — via createProduct
  //   (CLAUDE.md: "the trickiest logic in the codebase")
  // ═════════════════════════════════════════════════

  describe('option-value combination validation', () => {
    const colorRed = 'value-red';
    const colorBlue = 'value-blue';
    const sizeM = 'value-m';

    beforeEach(() => {
      prisma.product.findUnique.mockResolvedValue(null);
      prisma.productVariant.findMany.mockResolvedValue([]);
      prisma.option.count.mockResolvedValue(1); // one declared option: Color
    });

    it('rejects an optionValueId that does not exist', async () => {
      prisma.optionValue.findMany.mockResolvedValue([]); // none found

      await expect(
        service.createProduct(
          baseCreateDto({
            optionIds: ['opt-color'],
            variants: [baseVariant({ optionValueIds: [colorRed] })],
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an option value that belongs to an undeclared option', async () => {
      prisma.optionValue.findMany.mockResolvedValue([
        { id: colorRed, optionId: 'opt-color' },
      ]);

      await expect(
        service.createProduct(
          baseCreateDto({
            optionIds: ['opt-size'], // Color wasn't declared
            variants: [baseVariant({ optionValueIds: [colorRed] })],
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a variant with two values for the same declared option', async () => {
      prisma.optionValue.findMany.mockResolvedValue([
        { id: colorRed, optionId: 'opt-color' },
        { id: colorBlue, optionId: 'opt-color' },
      ]);

      await expect(
        service.createProduct(
          baseCreateDto({
            optionIds: ['opt-color'],
            variants: [baseVariant({ optionValueIds: [colorRed, colorBlue] })],
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a variant missing a value for a declared option', async () => {
      prisma.option.count.mockResolvedValue(2); // Color + Size declared
      prisma.optionValue.findMany.mockResolvedValue([
        { id: colorRed, optionId: 'opt-color' },
      ]);

      await expect(
        service.createProduct(
          baseCreateDto({
            optionIds: ['opt-color', 'opt-size'],
            // only supplies Color, never Size
            variants: [baseVariant({ optionValueIds: [colorRed] })],
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects two variants sharing the same option-value combination', async () => {
      prisma.optionValue.findMany.mockResolvedValue([
        { id: colorRed, optionId: 'opt-color' },
      ]);

      await expect(
        service.createProduct(
          baseCreateDto({
            optionIds: ['opt-color'],
            variants: [
              baseVariant({ sku: 'SKU-A', optionValueIds: [colorRed] }),
              baseVariant({ sku: 'SKU-B', optionValueIds: [colorRed] }),
            ],
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts variants with distinct valid combinations', async () => {
      prisma.optionValue.findMany.mockResolvedValue([
        { id: colorRed, optionId: 'opt-color' },
        { id: colorBlue, optionId: 'opt-color' },
      ]);
      prisma.product.create.mockResolvedValue({ id: 'p1' });
      prisma.productVariant.create.mockResolvedValue({ id: 'v1' });

      await expect(
        service.createProduct(
          baseCreateDto({
            optionIds: ['opt-color'],
            variants: [
              baseVariant({ sku: 'SKU-A', optionValueIds: [colorRed] }),
              baseVariant({ sku: 'SKU-B', optionValueIds: [colorBlue] }),
            ],
          }),
        ),
      ).resolves.toBeDefined();

      expect(prisma.productVariant.create).toHaveBeenCalledTimes(2);
    });

    it('does not touch the same option twice across unrelated variants (Buy Color=Red then Size=M is fine)', async () => {
      prisma.optionValue.findMany.mockResolvedValue([
        { id: colorRed, optionId: 'opt-color' },
        { id: sizeM, optionId: 'opt-size' },
      ]);
      prisma.option.count.mockResolvedValue(1); // only Color declared
      prisma.product.create.mockResolvedValue({ id: 'p1' });

      // sizeM belongs to an undeclared option -> must reject
      await expect(
        service.createProduct(
          baseCreateDto({
            optionIds: ['opt-color'],
            variants: [baseVariant({ optionValueIds: [colorRed, sizeM] })],
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ═════════════════════════════════════════════════
  //   findOneById / findOneBySlug
  // ═════════════════════════════════════════════════

  describe('findOneById / findOneBySlug', () => {
    it('throws NotFoundException when the product does not exist', async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(service.findOneById('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('excludes soft-deleted products from the lookup', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
      await service.findOneById('p1');

      expect(prisma.product.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'p1', deletedAt: null },
        }),
      );
    });

    it('looks up by slug with the same deletedAt guard', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
      await service.findOneBySlug('my-slug');

      expect(prisma.product.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            slug: 'my-slug',
            deletedAt: null,
          },
        }),
      );
    });
  });

  // ═════════════════════════════════════════════════
  //   updateProduct
  // ═════════════════════════════════════════════════

  describe('updateProduct', () => {
    it('throws NotFoundException when the product does not exist', async () => {
      prisma.product.findFirst.mockResolvedValue(null);

      await expect(
        service.updateProduct('missing', {} as UpdateProductDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a slug already used by a different product', async () => {
      prisma.product.findFirst
        .mockResolvedValueOnce({ id: 'p1' }) // ensureProductExists
        .mockResolvedValueOnce({ id: 'other-product' }); // slug conflict check

      await expect(
        service.updateProduct('p1', { slug: 'taken' } as UpdateProductDto),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects when primaryCategoryId is not in categoryIds', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });

      await expect(
        service.updateProduct('p1', {
          categoryIds: ['cat-1'],
          primaryCategoryId: 'cat-2',
        } as UpdateProductDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ═════════════════════════════════════════════════
  //   publish
  // ═════════════════════════════════════════════════

  describe('publish', () => {
    it('refuses to publish a product with no active variants', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.productVariant.count.mockResolvedValue(0);

      await expect(service.publish('p1')).rejects.toThrow(BadRequestException);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('publishes when at least one active variant exists', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.productVariant.count.mockResolvedValue(1);
      prisma.product.update.mockResolvedValue({ id: 'p1', status: 'ACTIVE' });

      const result = await service.publish('p1');

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { status: 'ACTIVE', isActive: true },
      });
      expect(result.data.status).toBe('ACTIVE');
    });
  });

  // ═════════════════════════════════════════════════
  //   addVariant
  // ═════════════════════════════════════════════════

  describe('addVariant', () => {
    beforeEach(() => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
    });

    it('rejects a duplicate SKU', async () => {
      prisma.productVariant.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        service.addVariant('p1', baseVariant() as AddVariantDto),
      ).rejects.toThrow(ConflictException);
    });

    it('requires optionValueIds when the product has declared options', async () => {
      prisma.productVariant.findUnique.mockResolvedValue(null);
      prisma.productOption.findMany.mockResolvedValue([
        { optionId: 'opt-color' },
      ]);

      await expect(
        service.addVariant(
          'p1',
          baseVariant({ optionValueIds: undefined }) as AddVariantDto,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a combination that already exists on another variant', async () => {
      prisma.productVariant.findUnique.mockResolvedValue(null);
      prisma.productOption.findMany.mockResolvedValue([
        { optionId: 'opt-color' },
      ]);
      prisma.optionValue.findMany.mockResolvedValue([
        { id: 'value-red', optionId: 'opt-color' },
      ]);
      prisma.productVariant.findMany.mockResolvedValue([
        {
          sku: 'EXISTING-SKU',
          optionValues: [{ optionValueId: 'value-red' }],
        },
      ]);

      await expect(
        service.addVariant(
          'p1',
          baseVariant({
            sku: 'NEW-SKU',
            optionValueIds: ['value-red'],
          }) as AddVariantDto,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('creates the variant when everything checks out', async () => {
      prisma.productVariant.findUnique.mockResolvedValue(null);
      prisma.productOption.findMany.mockResolvedValue([]); // no options declared
      prisma.productVariant.create.mockResolvedValue({ id: 'v1' });

      await service.addVariant('p1', baseVariant() as AddVariantDto);

      const { data } = firstCallArg<{
        data: { productId: string; sku: string };
      }>(prisma.productVariant.create);
      expect(data.productId).toBe('p1');
      expect(data.sku).toBe('SKU-1');
    });
  });

  // ═════════════════════════════════════════════════
  //   removeVariant
  // ═════════════════════════════════════════════════

  describe('removeVariant', () => {
    it('throws NotFoundException when the variant does not exist', async () => {
      prisma.productVariant.findUnique.mockResolvedValue(null);
      await expect(service.removeVariant('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses to delete the last remaining variant of a product', async () => {
      prisma.productVariant.findUnique.mockResolvedValue({
        id: 'v1',
        productId: 'p1',
      });
      prisma.productVariant.count.mockResolvedValue(1);

      await expect(service.removeVariant('v1')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.productVariant.delete).not.toHaveBeenCalled();
    });

    it('deletes the variant when others remain', async () => {
      prisma.productVariant.findUnique.mockResolvedValue({
        id: 'v1',
        productId: 'p1',
      });
      prisma.productVariant.count.mockResolvedValue(2);

      await service.removeVariant('v1');

      expect(prisma.productVariant.delete).toHaveBeenCalledWith({
        where: { id: 'v1' },
      });
    });
  });

  // ═════════════════════════════════════════════════
  //   adjustStock
  // ═════════════════════════════════════════════════

  describe('adjustStock', () => {
    it('throws NotFoundException when the variant does not exist', async () => {
      prisma.productVariant.findUnique.mockResolvedValue(null);
      await expect(
        service.adjustStock('missing', { delta: 1 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a decrement that would push stock negative', async () => {
      prisma.productVariant.findUnique.mockResolvedValue({
        id: 'v1',
        stock: 5,
      });

      await expect(service.adjustStock('v1', { delta: -10 })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.productVariant.update).not.toHaveBeenCalled();
    });

    it('applies a positive delta correctly', async () => {
      prisma.productVariant.findUnique.mockResolvedValue({
        id: 'v1',
        stock: 5,
      });
      prisma.productVariant.update.mockResolvedValue({ id: 'v1', stock: 15 });

      const result = await service.adjustStock('v1', { delta: 10 });

      expect(prisma.productVariant.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: { stock: 15 },
      });
      expect(result.data.stock).toBe(15);
    });

    it('applies a negative delta down to exactly zero', async () => {
      prisma.productVariant.findUnique.mockResolvedValue({
        id: 'v1',
        stock: 5,
      });
      prisma.productVariant.update.mockResolvedValue({ id: 'v1', stock: 0 });

      await service.adjustStock('v1', { delta: -5 });

      expect(prisma.productVariant.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: { stock: 0 },
      });
    });
  });
});
