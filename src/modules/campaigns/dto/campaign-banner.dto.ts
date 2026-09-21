import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createCampaignBannerSchema = z.object({
  title: z.string().max(255).optional(),
  imageUrl: z.string().url(),
  mobileImageUrl: z.string().url().optional(),
  linkUrl: z.string().url().optional(),
  position: z.number().int().nonnegative().optional().default(0),
  isActive: z.boolean().optional().default(true),
});

export class CreateCampaignBannerDto extends createZodDto(
  createCampaignBannerSchema,
) {}

export const updateCampaignBannerSchema = createCampaignBannerSchema.partial();


export class UpdateCampaignBannerDto extends createZodDto(
  updateCampaignBannerSchema,
) {}

export const reorderBannersSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        position: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

export class ReorderBannersDto extends createZodDto(reorderBannersSchema) {}
