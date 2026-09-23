import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ══════════════ ENUMS ══════════════ */
export const productStatusEnum = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);

/* ══════════════ SUB-SCHEMAS ══════════════ */
export const productImageSchema = z.object({
  url: z.string().url(),
  altText: z.string().max(255).optional(),
  isPrimary: z.boolean().optional(),
  position: z.number().int().nonnegative().optional(),
});

export const variantImageSchema = z.object({
  url: z.string().url(),
  altText: z.string().max(255).optional(),
  isPrimary: z.boolean().optional(),
  position: z.number().int().nonnegative().optional(),
});

export const variantSchema = z.object({
  sku: z.string().min(1).max(100),
  price: z.coerce.number().nonnegative().multipleOf(0.01),
  stock: z.number().int().nonnegative().optional().default(0),
  isActive: z.boolean().optional().default(true),
  optionValueIds: z.array(z.string().uuid()).optional(),
  images: z.array(variantImageSchema).optional(),
});

/* ══════════════ CREATE ══════════════ */
export const createProductSchema = z.object({
  name: z.string().min(2).max(255),
  description: z.string().min(2).optional(),
  shortDescription: z.string().max(500).optional(),
  slug: z
    .string()
    .min(2)
    .max(255)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  status: productStatusEnum.optional().default('DRAFT'),
  isActive: z.boolean().optional().default(true),
  brandId: z.string().uuid().optional(),
  images: z.array(productImageSchema).optional(),
  categoryIds: z.array(z.string().uuid()).optional(),
  primaryCategoryId: z.string().uuid().optional(),
  tagIds: z.array(z.string().uuid()).optional(),
  optionIds: z.array(z.string().uuid()).optional(),
  variants: z.array(variantSchema).min(1, 'At least one variant is required'),
});

export class CreateProductDto extends createZodDto(createProductSchema) {}

/* ══════════════ UPDATE (base only, not variants/images) ══════════════ */
export const updateProductSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  description: z.string().optional().nullable(),
  shortDescription: z.string().max(500).optional().nullable(),
  slug: z
    .string()
    .min(2)
    .max(255)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  status: productStatusEnum.optional(),
  isActive: z.boolean().optional(),
  brandId: z.string().uuid().optional().nullable(),
  categoryIds: z.array(z.string().uuid()).optional(),
  primaryCategoryId: z.string().uuid().optional().nullable(),
  tagIds: z.array(z.string().uuid()).optional(),
});

export class UpdateProductDto extends createZodDto(updateProductSchema) {}

/* ══════════════ QUERY ══════════════ */
export const productQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  status: productStatusEnum.optional(),
  isActive: z.preprocess((v) => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }, z.boolean().optional()),
  brandId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  includeDeleted: z.preprocess((v) => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }, z.boolean().optional().default(false)),
  sortBy: z
    .enum(['createdAt', 'name', 'updatedAt'])
    .optional()
    .default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

export class ProductQueryDto extends createZodDto(productQuerySchema) {}
