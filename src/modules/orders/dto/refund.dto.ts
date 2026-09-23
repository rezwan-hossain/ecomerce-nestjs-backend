import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   REFUND REQUEST SCHEMAS & DTOS
   ========================================== */

export const createRefundRequestSchema = z.object({
  reason: z.string().min(1).max(500),
  amount: z.coerce.number().positive().multipleOf(0.01),
});

export class CreateRefundRequestDto extends createZodDto(
  createRefundRequestSchema,
) {}

export const reviewRefundRequestSchema = z.object({
  adminNote: z.string().max(500).optional(),
  processedByUserId: z.string().uuid().optional(),
});

export class ReviewRefundRequestDto extends createZodDto(
  reviewRefundRequestSchema,
) {}
