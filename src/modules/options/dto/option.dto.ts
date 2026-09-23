import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   OPTION SCHEMAS & DTOS
   ========================================== */

export const createOptionSchema = z.object({
  name: z.string().min(1).max(50),
});

export class CreateOptionDto extends createZodDto(createOptionSchema) {}

// Partial schema for PATCH requests
export const updateOptionSchema = createOptionSchema.partial();

export class UpdateOptionDto extends createZodDto(updateOptionSchema) {}

// Query schema for pagination & search
export const optionQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
});

export class OptionQueryDto extends createZodDto(optionQuerySchema) {}
