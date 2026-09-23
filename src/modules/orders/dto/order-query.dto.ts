import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   ORDER QUERY SCHEMAS & DTOS
   ========================================== */

export const orderStatusEnum = z.enum([
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'READY_TO_SHIP',
  'SHIPPED',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
  'REFUNDED',
]);

export const orderQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(), // orderNumber / customerEmail / customerName
  status: orderStatusEnum.optional(),
  userId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  sortBy: z.enum(['createdAt', 'totalAmount']).optional().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

export class OrderQueryDto extends createZodDto(orderQuerySchema) {}

export const orderLookupQuerySchema = z.object({
  orderNumber: z.string().min(1),
  email: z.string().email(),
});

export class OrderLookupQueryDto extends createZodDto(orderLookupQuerySchema) {}

export const myOrdersQuerySchema = z.object({
  userId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: orderStatusEnum.optional(),
});

export class MyOrdersQueryDto extends createZodDto(myOrdersQuerySchema) {}
