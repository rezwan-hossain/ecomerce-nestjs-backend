import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createCampaignSectionSchema = z.object({
  title: z.string().min(2).max(255),
  slug: z
    .string()
    .max(255)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional().default(true),
  position: z.number().int().nonnegative().optional().default(0),
  bannerUrl: z.string().url().optional(),
});

export class CreateCampaignSectionDto extends createZodDto(
  createCampaignSectionSchema,
) {}

export const updateCampaignSectionSchema = createCampaignSectionSchema.partial();
export class UpdateCampaignSectionDto extends createZodDto(
  updateCampaignSectionSchema,
) {}

export const attachSectionProductsSchema = z.object({
  products: z
    .array(
      z.object({
        productId: z.string().uuid(),
        position: z.number().int().nonnegative().optional().default(0),
      }),
    )
    .min(1),
});

export class AttachSectionProductsDto extends createZodDto(
  attachSectionProductsSchema,
) {}

export const reorderSectionsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        position: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

export class ReorderSectionsDto extends createZodDto(reorderSectionsSchema) {}
