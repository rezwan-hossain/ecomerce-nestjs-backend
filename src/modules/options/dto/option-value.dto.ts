import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   OPTION VALUE SCHEMAS & DTOS
   ========================================== */

export const createOptionValueSchema = z.object({
  value: z.string().min(1).max(50),
});

export class CreateOptionValueDto extends createZodDto(
  createOptionValueSchema,
) {}

// Partial schema for PATCH requests
export const updateOptionValueSchema = createOptionValueSchema.partial();

export class UpdateOptionValueDto extends createZodDto(
  updateOptionValueSchema,
) {}
