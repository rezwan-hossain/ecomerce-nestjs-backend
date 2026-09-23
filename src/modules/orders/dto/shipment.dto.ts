import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   SHIPMENT SCHEMAS & DTOS
   ========================================== */

export const shipmentStatusEnum = z.enum([
  'PENDING',
  'PROCESSING',
  'SHIPPED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNED',
  'CANCELLED',
]);

export const createShipmentSchema = z.object({
  carrier: z.string().max(100).optional(),
  service: z.string().max(100).optional(),
  trackingNumber: z.string().max(150).optional(),
  trackingUrl: z.string().url().optional(),
  shippingAmount: z.coerce.number().nonnegative().multipleOf(0.01).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export class CreateShipmentDto extends createZodDto(createShipmentSchema) {}

export const updateShipmentSchema = z.object({
  status: shipmentStatusEnum.optional(),
  carrier: z.string().max(100).optional(),
  service: z.string().max(100).optional(),
  trackingNumber: z.string().max(150).optional(),
  trackingUrl: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export class UpdateShipmentDto extends createZodDto(updateShipmentSchema) {}
