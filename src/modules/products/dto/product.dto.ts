import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createProductSchema = z.object({
  name: z.string().min(2),
  description: z.string().min(2),
  slug: z.string().min(2),
});

export class CreateProductDto extends createZodDto(createProductSchema) {}
