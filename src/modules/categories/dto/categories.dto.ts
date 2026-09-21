import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ══════════════ CREATE ══════════════ */
export const createCategorySchema = z.object({
  name: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/, {
      message:
        'Slug must contain only lowercase alphanumeric characters and hyphens',
    }),
  parentId: z.string().uuid().optional().nullable(),
  isActive: z.boolean().optional().default(true),
  position: z.number().int().nonnegative().optional().default(0),
});

export class CreateCategoryDto extends createZodDto(createCategorySchema) {}

/* ══════════════ UPDATE ══════════════ */
export const updateCategorySchema = z.object({
  name: z.string().min(2).max(100).optional(),
  slug: z
    .string()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  parentId: z.string().uuid().optional().nullable(),
  isActive: z.boolean().optional(),
  position: z.number().int().nonnegative().optional(),
});

export class UpdateCategoryDto extends createZodDto(updateCategorySchema) {}

/* ══════════════ QUERY ══════════════ */
export const categoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  parentId: z.union([z.string().uuid(), z.literal('null')]).optional(),
  isActive: z.preprocess((v) => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }, z.boolean().optional()),
  includeTree: z.preprocess((v) => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }, z.boolean().optional()),
});

export class CategoryQueryDto extends createZodDto(categoryQuerySchema) {}
