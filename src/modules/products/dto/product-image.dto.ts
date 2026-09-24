import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { productImageSchema } from './product.dto';

export const addProductImagesSchema = z.object({
  images: z.array(productImageSchema).min(1, 'At least one image is required'),
});
export class AddProductImagesDto extends createZodDto(addProductImagesSchema) {}

export const updateProductImageSchema = z.object({
  altText: z.string().max(255).optional().nullable(),
  isPrimary: z.boolean().optional(),
  position: z.number().int().nonnegative().optional(),
});
export class UpdateProductImageDto extends createZodDto(
  updateProductImageSchema,
) {}

export const reorderProductImagesSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        position: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});
export class ReorderProductImagesDto extends createZodDto(
  reorderProductImagesSchema,
) {}
