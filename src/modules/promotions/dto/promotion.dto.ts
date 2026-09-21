import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const promotionTypeEnum = z.enum([
  'PERCENTAGE',
  'FIXED_AMOUNT',
  'FIXED_PRICE',
  'BUY_X_GET_Y',
  'FREE_SHIPPING',
  'SHIPPING_DISCOUNT',
]);

export const promotionStatusEnum = z.enum([
  'DRAFT',
  'SCHEDULED',
  'ACTIVE',
  'ENDED',
  'ARCHIVED',
]);

/* ══════════════ CREATE ══════════════ */
export const createPromotionSchema = z
  .object({
    name: z.string().min(2).max(255),
    description: z.string().optional(),
    type: promotionTypeEnum,
    status: promotionStatusEnum.optional().default('DRAFT'),
    value: z.coerce.number().nonnegative().optional(),

    buyQuantity: z.number().int().positive().optional(),
    getQuantity: z.number().int().positive().optional(),

    minOrderAmount: z.coerce.number().nonnegative().optional(),
    maxDiscountAmount: z.coerce.number().nonnegative().optional(),

    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),

    isActive: z.boolean().optional().default(true),
    priority: z.number().int().nonnegative().optional().default(0),
  })
  .refine(
    (d) => {
      if (d.startsAt && d.endsAt) return d.endsAt > d.startsAt;
      return true;
    },
    { message: 'endsAt must be after startsAt', path: ['endsAt'] },
  )
  .refine(
    (d) => {
      if (d.type === 'BUY_X_GET_Y') return !!d.buyQuantity && !!d.getQuantity;
      return true;
    },
    {
      message: 'buyQuantity and getQuantity are required for BUY_X_GET_Y',
      path: ['buyQuantity'],
    },
  )
  .refine(
    (d) => {
      const needsValue = [
        'PERCENTAGE',
        'FIXED_AMOUNT',
        'FIXED_PRICE',
        'SHIPPING_DISCOUNT',
      ];
      if (needsValue.includes(d.type))
        return d.value !== undefined && d.value >= 0;
      return true;
    },
    {
      message: 'value is required for this promotion type',
      path: ['value'],
    },
  )
  .refine(
    (d) => {
      if (d.type === 'PERCENTAGE' && d.value !== undefined)
        return d.value <= 100;
      return true;
    },
    {
      message: 'Percentage value cannot exceed 100',
      path: ['value'],
    },
  )
  .refine(
    (d) => {
      if (d.minOrderAmount !== undefined && d.maxDiscountAmount !== undefined)
        return d.maxDiscountAmount >= 0;
      return true;
    },
    { message: 'maxDiscountAmount must be non-negative' },
  );

export class CreatePromotionDto extends createZodDto(createPromotionSchema) {}

/* ══════════════ UPDATE ══════════════ */
export const updatePromotionSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  description: z.string().optional().nullable(),
  type: promotionTypeEnum.optional(),
  status: promotionStatusEnum.optional(),
  value: z.coerce.number().nonnegative().optional().nullable(),
  buyQuantity: z.number().int().positive().optional().nullable(),
  getQuantity: z.number().int().positive().optional().nullable(),
  minOrderAmount: z.coerce.number().nonnegative().optional().nullable(),
  maxDiscountAmount: z.coerce.number().nonnegative().optional().nullable(),
  startsAt: z.iso.datetime().optional().nullable(),
  endsAt: z.iso.datetime().optional().nullable(),
  isActive: z.boolean().optional(),
  priority: z.number().int().nonnegative().optional(),
});

export class UpdatePromotionDto extends createZodDto(updatePromotionSchema) {}

/* ══════════════ QUERY ══════════════ */
export const promotionQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  type: promotionTypeEnum.optional(),
  status: promotionStatusEnum.optional(),
  isActive: z.preprocess((v) => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }, z.boolean().optional()),
});

export class PromotionQueryDto extends createZodDto(promotionQuerySchema) {}
