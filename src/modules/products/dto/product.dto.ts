import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* =========================
   ENUMS
========================= */

export const productStatusEnum = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);

/* =========================
   TAG
========================= */

export const createTagSchema = z.object({
  name: z.string().min(1).max(50),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/),
});

export class CreateTagDto extends createZodDto(createTagSchema) {}

/* =========================
   CATEGORY
========================= */

export const createCategorySchema = z.object({
  name: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/),

  parentId: z.uuid().optional(),
});

export class CreateCategoryDto extends createZodDto(createCategorySchema) {}

/* =========================
   BRAND
========================= */

export const createBrandSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/),

  logoUrl: z.url().optional(),
});

export class CreateBrandDto extends createZodDto(createBrandSchema) {}

/* =========================
   PRODUCT
========================= */

export const createProductSchema = z.object({
  name: z.string().min(2).max(255),
  description: z.string().min(2),
  shortDescription: z.string().max(500).optional(),
  slug: z
    .string()
    .min(2)
    .max(255)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  status: productStatusEnum.optional(),
  isActive: z.boolean().optional(),
  brandId: z.uuid().optional(),
  categoryIds: z.array(z.uuid()).optional(),
  /*
    Existing tag ids
  */
  tagIds: z.array(z.uuid()).optional(),
});

export class CreateProductDto extends createZodDto(createProductSchema) {}

/* =========================
   UPDATE PRODUCT
========================= */

export const updateProductSchema = createProductSchema.partial();

export class UpdateProductDto extends createZodDto(updateProductSchema) {}
