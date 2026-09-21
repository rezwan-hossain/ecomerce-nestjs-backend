import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const reorderCategoriesSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        position: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

export class ReorderCategoriesDto extends createZodDto(
  reorderCategoriesSchema,
) {}

export const moveCategorySchema = z.object({
  newParentId: z.string().uuid().optional().nullable(),
  position: z.number().int().nonnegative().optional(),
});

export class MoveCategoryDto extends createZodDto(moveCategorySchema) {}
