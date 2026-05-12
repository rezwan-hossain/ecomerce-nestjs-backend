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
const productImageSchema = z.object({
  url: z.url(),
  altText: z.string().max(255).optional(),
  isPrimary: z.boolean().optional(),
});

const variantImageSchema = z.object({
  url: z.url(),
  altText: z.string().max(255).optional(),
  isPrimary: z.boolean().optional(),
  position: z.number().int().nonnegative().optional(),
});

const variantSchema = z.object({
  sku: z.string().min(1).max(100),
  price: z.coerce.number().nonnegative().multipleOf(0.01), // max 2 decimal places
  stock: z.number().int().nonnegative().default(0),
  isActive: z.boolean().optional(),
  // flat UUID array — matches what the service expects
  optionValueIds: z.array(z.uuid()).optional(),
  images: z.array(variantImageSchema).optional(),
});

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
  status: productStatusEnum.optional(),
  isActive: z.boolean().optional(),
  brandId: z.uuid().optional(),
  images: z.array(productImageSchema).optional(),

  // categories: z.array(
  //   z.object({
  //     categoryId: z.string(),
  //   }),
  // ),
  // tags: z.array(
  //   z.object({
  //     tagId: z.string(),
  //   }),
  // ),
  categoryIds: z.array(z.uuid()).optional(),
  tagIds: z.array(z.uuid()).optional(),
  optionIds: z.array(z.uuid()).optional(),
  variants: z.array(variantSchema).min(1, 'At least one variant is required'),

  // variants: z.array(
  //   z.object({
  //     name: z.string().min(1).max(255),
  //     sku: z.string().min(1).max(100),
  //     price: z.coerce.number().nonnegative(),
  //     stock: z.number().int().nonnegative().default(0),
  //   }),
  // ),
  // options: z
  //   .array(
  //     z.object({
  //       optionId: z.string().uuid(),
  //     }),
  //   )
  // .default([]),
  /*
    Existing tag ids
  */
});

export class CreateProductDto extends createZodDto(createProductSchema) {}

/* =========================
   UPDATE PRODUCT
========================= */

export const updateProductSchema = createProductSchema.partial();

export class UpdateProductDto extends createZodDto(updateProductSchema) {}
