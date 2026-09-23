import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { variantImageSchema } from './product.dto';

export const addVariantSchema = z.object({
  sku: z.string().min(1).max(100),
  price: z.coerce.number().nonnegative().multipleOf(0.01),
  stock: z.number().int().nonnegative().optional().default(0),
  isActive: z.boolean().optional().default(true),
  optionValueIds: z.array(z.string().uuid()).optional(),
  images: z.array(variantImageSchema).optional(),
});
export class AddVariantDto extends createZodDto(addVariantSchema) {}

export const updateVariantSchema = z.object({
  sku: z.string().min(1).max(100).optional(),
  price: z.coerce.number().nonnegative().multipleOf(0.01).optional(),
  stock: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
});
export class UpdateVariantDto extends createZodDto(updateVariantSchema) {}

export const adjustStockSchema = z.object({
  delta: z.number().int(), // positive to add, negative to reduce
  reason: z.string().max(500).optional(),
});
export class AdjustStockDto extends createZodDto(adjustStockSchema) {}
