import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   CART ITEM SCHEMAS & DTOS
   ========================================== */

export const addCartItemSchema = z.object({
  variantId: z.string().uuid(),
  quantity: z.number().int().min(1).max(999).optional().default(1),
});

export class AddCartItemDto extends createZodDto(addCartItemSchema) {}

export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(1).max(999),
});

export class UpdateCartItemDto extends createZodDto(updateCartItemSchema) {}
