import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { paymentMethodEnum, paymentProviderEnum } from './checkout.dto';

/* ==========================================
   PAYMENT SCHEMAS & DTOS
   ========================================== */

export const createPaymentSchema = z.object({
  provider: paymentProviderEnum,
  method: paymentMethodEnum,
});

export class CreatePaymentDto extends createZodDto(createPaymentSchema) {}

export const markPaymentPaidSchema = z.object({
  transactionId: z.string().max(150).optional(),
  providerReference: z.string().max(150).optional(),
});

export class MarkPaymentPaidDto extends createZodDto(markPaymentPaidSchema) {}

export const markPaymentFailedSchema = z.object({
  failureCode: z.string().max(100).optional(),
  failureMessage: z.string().max(500).optional(),
});

export class MarkPaymentFailedDto extends createZodDto(
  markPaymentFailedSchema,
) {}
