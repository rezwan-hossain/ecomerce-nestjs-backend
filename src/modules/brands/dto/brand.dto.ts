import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   BRAND SCHEMAS & DTOS
   ========================================== */

export const createBrandSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/, {
      message:
        'Slug must contain only lowercase alphanumeric characters and hyphens',
    }),
  logoUrl: z.string().url().optional().or(z.literal('')),
});

export class CreateBrandDto extends createZodDto(createBrandSchema) {}

// Partial schema for PATCH requests
export const updateBrandSchema = createBrandSchema.partial();

export class UpdateBrandDto extends createZodDto(updateBrandSchema) {}

// Schema for handling pagination, sorting, and searching
export const brandQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
});

export class BrandQueryDto extends createZodDto(brandQuerySchema) {}
