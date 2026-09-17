import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   TAG SCHEMAS & DTOS
   ========================================== */

export const createTagSchema = z.object({
  name: z.string().min(1).max(50),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, {
      message:
        'Slug must contain only lowercase alphanumeric characters and hyphens',
    }),
});

export class CreateTagDto extends createZodDto(createTagSchema) {}

// Partial schema for PATCH requests
export const updateTagSchema = createTagSchema.partial();

export class UpdateTagDto extends createZodDto(updateTagSchema) {}

// Query schema for pagination & search
export const tagQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
});

export class TagQueryDto extends createZodDto(tagQuerySchema) {}
