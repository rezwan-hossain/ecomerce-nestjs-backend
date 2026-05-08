import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createProductSchema = z.object({
  name: z.string().min(2),

  description: z.string().min(2),

  shortDescription: z.string().optional(),

  slug: z.string().min(2),

  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),

  isActive: z.boolean().optional(),

  brandId: z.string().uuid({ version: 'v7' }).optional(),

  categoryIds: z.array(z.string().uuid()).optional(),

  tags: z
    .array(
      z.object({
        tag: z.string().min(1),
        slug: z.string().min(1),
      }),
    )
    .optional(),
});

export class CreateProductDto extends createZodDto(createProductSchema) {}
