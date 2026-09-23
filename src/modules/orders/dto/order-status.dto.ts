import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { orderStatusEnum } from './order-query.dto';

/* ==========================================
   ORDER STATUS SCHEMAS & DTOS
   ========================================== */

export const updateOrderStatusSchema = z.object({
  status: orderStatusEnum,
  note: z.string().max(500).optional(),
});

export class UpdateOrderStatusDto extends createZodDto(
  updateOrderStatusSchema,
) {}

export const cancelOrderSchema = z.object({
  reason: z.string().min(1).max(500),
});

export class CancelOrderDto extends createZodDto(cancelOrderSchema) {}
