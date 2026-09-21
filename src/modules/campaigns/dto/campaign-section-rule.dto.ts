import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ruleMatchEnum = z.enum(['ANY', 'ALL']);

export const createSectionRuleSchema = z
  .object({
    categoryId: z.string().uuid().optional(),
    brandId: z.string().uuid().optional(),
    tagId: z.string().uuid().optional(),
    matchType: ruleMatchEnum.optional().default('ANY'),
    minPrice: z.coerce.number().nonnegative().optional(),
    maxPrice: z.coerce.number().nonnegative().optional(),
  })
  .refine(
    (d) =>
      d.categoryId ||
      d.brandId ||
      d.tagId ||
      d.minPrice !== undefined ||
      d.maxPrice !== undefined,
    {
      message: 'At least one filter (category, brand, tag, price) is required',
    },
  )
  .refine(
    (d) => {
      if (d.minPrice !== undefined && d.maxPrice !== undefined)
        return d.maxPrice >= d.minPrice;
      return true;
    },
    {
      message: 'maxPrice must be greater than or equal to minPrice',
      path: ['maxPrice']
    },
  );

export class CreateSectionRuleDto extends createZodDto(
  createSectionRuleSchema,
) {}

export const updateSectionRuleSchema = z.object({
  categoryId: z.string().uuid().optional().nullable(),
  brandId: z.string().uuid().optional().nullable(),
  tagId: z.string().uuid().optional().nullable(),
  matchType: ruleMatchEnum.optional(),
  minPrice: z.coerce.number().nonnegative().optional().nullable(),
  maxPrice: z.coerce.number().nonnegative().optional().nullable(),
});

export class UpdateSectionRuleDto extends createZodDto(
  updateSectionRuleSchema,
) {}
