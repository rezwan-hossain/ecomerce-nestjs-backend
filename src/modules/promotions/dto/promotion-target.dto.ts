import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const promotionTargetTypeEnum = z.enum([
  'PRODUCT',
  'VARIANT',
  'CATEGORY',
  'BRAND',
  'TAG',
  'ALL_PRODUCTS',
]);

export const promotionTargetSchema = z
  .object({
    targetType: promotionTargetTypeEnum,
    productId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
    brandId: z.string().uuid().optional(),
    tagId: z.string().uuid().optional(),
  })
  .refine(
    (t) => {
      switch (t.targetType) {
        case 'PRODUCT':
          return !!t.productId;
        case 'VARIANT':
          return !!t.variantId;
        case 'CATEGORY':
          return !!t.categoryId;
        case 'BRAND':
          return !!t.brandId;
        case 'TAG':
          return !!t.tagId;
        case 'ALL_PRODUCTS':
          return true;
      }
    },
    {
      message:
        'Target ID must match targetType (e.g. PRODUCT requires productId, CATEGORY requires categoryId, etc.)',
    },
  );

export const attachTargetsSchema = z.object({
  targets: z.array(promotionTargetSchema).min(1),
});

export class AttachTargetsDto extends createZodDto(attachTargetsSchema) {}
