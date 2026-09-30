import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   VARIANT TEMPLATE SCHEMAS & DTOS
   ========================================== */

// One option in a template, e.g. Size → [S, M, L]
export const templateOptionSchema = z.object({
  optionId: z.string().uuid(),
  optionValueIds: z
    .array(z.string().uuid())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'optionValueIds must not contain duplicates',
    }),
});

const templateOptionsSchema = z
  .array(templateOptionSchema)
  .min(1)
  .refine(
    (options) =>
      new Set(options.map((o) => o.optionId)).size === options.length,
    { message: 'Each optionId may appear only once per template' },
  );

export const createVariantTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  options: templateOptionsSchema,
});

export class CreateVariantTemplateDto extends createZodDto(
  createVariantTemplateSchema,
) {}

// PATCH: when `options` is provided it replaces the template's option set
export const updateVariantTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  options: templateOptionsSchema.optional(),
});

export class UpdateVariantTemplateDto extends createZodDto(
  updateVariantTemplateSchema,
) {}

// Query schema for pagination & search
export const variantTemplateQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
});

export class VariantTemplateQueryDto extends createZodDto(
  variantTemplateQuerySchema,
) {}
