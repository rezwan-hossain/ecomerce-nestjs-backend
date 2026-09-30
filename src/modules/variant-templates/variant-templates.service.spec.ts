import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { VariantTemplatesService } from './variant-templates.service';
import { PrismaService } from 'src/prisma/prisma.service';

function createMockPrisma() {
  return {
    variantTemplate: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    option: { count: jest.fn() },
    optionValue: { findMany: jest.fn() },
  };
}

type MockPrisma = ReturnType<typeof createMockPrisma>;

function firstCallArg<T>(mockFn: jest.Mock): T {
  const args = mockFn.mock.calls[0] as unknown[];
  return args[0] as T;
}

const SIZE = 'size-option-id';
const COLOR = 'color-option-id';

describe('VariantTemplatesService', () => {
  let service: VariantTemplatesService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VariantTemplatesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<VariantTemplatesService>(VariantTemplatesService);
  });

  describe('create', () => {
    const dto = {
      name: 'Shoe Sizes',
      options: [{ optionId: SIZE, optionValueIds: ['s', 'm'] }],
    };

    it('creates the template with nested options and values', async () => {
      prisma.option.count.mockResolvedValue(1);
      prisma.optionValue.findMany.mockResolvedValue([
        { id: 's', optionId: SIZE },
        { id: 'm', optionId: SIZE },
      ]);
      prisma.variantTemplate.create.mockResolvedValue({ id: 't1' });

      const result = await service.create(dto);

      expect(result).toEqual({
        message: 'Variant template created successfully',
        data: { id: 't1' },
      });
      const arg = firstCallArg<{ data: unknown }>(
        prisma.variantTemplate.create,
      );
      expect(arg.data).toEqual({
        name: 'Shoe Sizes',
        description: undefined,
        options: {
          create: [
            {
              optionId: SIZE,
              values: {
                create: [{ optionValueId: 's' }, { optionValueId: 'm' }],
              },
            },
          ],
        },
      });
    });

    it('rejects when an option does not exist', async () => {
      prisma.option.count.mockResolvedValue(0);

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
      expect(prisma.variantTemplate.create).not.toHaveBeenCalled();
    });

    it('rejects when an option value does not exist', async () => {
      prisma.option.count.mockResolvedValue(1);
      prisma.optionValue.findMany.mockResolvedValue([
        { id: 's', optionId: SIZE },
      ]);

      await expect(service.create(dto)).rejects.toThrow(
        'Option values not found: m',
      );
    });

    it('rejects a value that belongs to a different option', async () => {
      prisma.option.count.mockResolvedValue(1);
      prisma.optionValue.findMany.mockResolvedValue([
        { id: 's', optionId: SIZE },
        { id: 'm', optionId: COLOR },
      ]);

      await expect(service.create(dto)).rejects.toThrow(
        `Option values m do not belong to option ${SIZE}`,
      );
    });

    it('maps a duplicate name to ConflictException', async () => {
      prisma.option.count.mockResolvedValue(1);
      prisma.optionValue.findMany.mockResolvedValue([
        { id: 's', optionId: SIZE },
        { id: 'm', optionId: SIZE },
      ]);
      prisma.variantTemplate.create.mockRejectedValue(
        new PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    it('paginates and filters by name', async () => {
      prisma.variantTemplate.findMany.mockResolvedValue([{ id: 't1' }]);
      prisma.variantTemplate.count.mockResolvedValue(11);

      const result = await service.findAll({
        page: 2,
        limit: 10,
        search: 'shoe',
      });

      const arg = firstCallArg<{ skip: number; take: number; where: unknown }>(
        prisma.variantTemplate.findMany,
      );
      expect(arg.skip).toBe(10);
      expect(arg.take).toBe(10);
      expect(arg.where).toEqual({
        name: { contains: 'shoe', mode: 'insensitive' },
      });
      expect(result.meta).toEqual({
        total: 11,
        page: 2,
        limit: 10,
        totalPages: 2,
      });
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException when missing', async () => {
      prisma.variantTemplate.findUnique.mockResolvedValue(null);

      await expect(service.findOne('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('replaces options when provided', async () => {
      prisma.variantTemplate.findUnique.mockResolvedValue({ id: 't1' });
      prisma.option.count.mockResolvedValue(1);
      prisma.optionValue.findMany.mockResolvedValue([
        { id: 'red', optionId: COLOR },
      ]);
      prisma.variantTemplate.update.mockResolvedValue({ id: 't1' });

      await service.update('t1', {
        options: [{ optionId: COLOR, optionValueIds: ['red'] }],
      });

      const arg = firstCallArg<{ data: { options: unknown } }>(
        prisma.variantTemplate.update,
      );
      expect(arg.data.options).toEqual({
        deleteMany: {},
        create: [
          {
            optionId: COLOR,
            values: { create: [{ optionValueId: 'red' }] },
          },
        ],
      });
    });

    it('leaves options untouched when not provided', async () => {
      prisma.variantTemplate.findUnique.mockResolvedValue({ id: 't1' });
      prisma.variantTemplate.update.mockResolvedValue({ id: 't1' });

      await service.update('t1', { description: null });

      const arg = firstCallArg<{ data: Record<string, unknown> }>(
        prisma.variantTemplate.update,
      );
      expect(arg.data).toEqual({ description: null });
      expect(prisma.option.count).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when missing', async () => {
      prisma.variantTemplate.findUnique.mockResolvedValue(null);

      await expect(service.update('nope', { name: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('deletes an existing template', async () => {
      prisma.variantTemplate.findUnique.mockResolvedValue({ id: 't1' });

      await expect(service.remove('t1')).resolves.toEqual({
        message: 'Variant template deleted successfully',
      });
      expect(prisma.variantTemplate.delete).toHaveBeenCalledWith({
        where: { id: 't1' },
      });
    });
  });
});
