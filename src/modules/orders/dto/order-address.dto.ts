import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   ORDER ADDRESS SCHEMAS & DTOS
   ========================================== */

export const orderAddressSchema = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().max(30).optional(),
  company: z.string().max(150).optional(),
  addressLine1: z.string().min(1).max(255),
  addressLine2: z.string().max(255).optional(),
  city: z.string().min(1).max(100),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().min(2).max(100),
});

export const updateOrderAddressSchema = orderAddressSchema.partial();

export class UpdateOrderAddressDto extends createZodDto(
  updateOrderAddressSchema,
) {}
