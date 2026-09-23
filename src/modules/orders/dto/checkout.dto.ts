import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { orderAddressSchema } from './order-address.dto';

/* ==========================================
   CHECKOUT SCHEMA & DTO
   ========================================== */

export const paymentProviderEnum = z.enum([
  'STRIPE',
  'SSLCOMMERZ',
  'BKASH',
  'NAGAD',
  'COD',
  'OTHER',
]);

export const paymentMethodEnum = z.enum([
  'CARD',
  'MOBILE_BANKING',
  'BANK_TRANSFER',
  'CASH_ON_DELIVERY',
  'OTHER',
]);

export const checkoutSchema = z.object({
  customerEmail: z.string().email(),
  customerName: z.string().max(150).optional(),
  customerPhone: z.string().max(30).optional(),
  customerNote: z.string().max(1000).optional(),
  shippingAddress: orderAddressSchema,
  // Defaults to shippingAddress when omitted.
  billingAddress: orderAddressSchema.optional(),
  paymentProvider: paymentProviderEnum,
  paymentMethod: paymentMethodEnum,
});

export class CheckoutDto extends createZodDto(checkoutSchema) {}
