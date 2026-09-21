import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const campaignStatusEnum = z.enum([
  'DRAFT',
  'SCHEDULED',
  'ACTIVE',
  'ENDED',
  'ARCHIVED',
]);

/* ══════════════ CREATE ══════════════ */
export const createCampaignSchema = z
  .object({
    name: z.string().min(2).max(255),
    slug: z
      .string()
      .min(2)
      .max(255)
      .regex(/^[a-z0-9-]+$/, {
        message: 'Slug must be lowercase alphanumeric with hyphens',
      }),
    description: z.string().optional(),
    status: campaignStatusEnum.optional().default('DRAFT'),
    startsAt: z.iso.datetime().optional(), // ← fixed
    endsAt: z.iso.datetime().optional(), // ← fixed
    bannerUrl: z.string().url().optional(),
    thumbnailUrl: z.string().url().optional(),
    isActive: z.boolean().optional().default(true),
    isFeatured: z.boolean().optional().default(false),
    metaTitle: z.string().max(255).optional(),
    metaDescription: z.string().max(500).optional(),
    metaImageUrl: z.string().url().optional(),
  })
  .refine(
    (data) => {
      if (data.startsAt && data.endsAt) {
        return new Date(data.endsAt) > new Date(data.startsAt);
      }
      return true;
    },
    { message: 'endsAt must be after startsAt', path: ['endsAt'] },
  );

export class CreateCampaignDto extends createZodDto(createCampaignSchema) {}

/* ══════════════ UPDATE ══════════════ */
export const updateCampaignSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().optional().nullable(),
  status: campaignStatusEnum.optional(),
  startsAt: z.iso.datetime().optional().nullable(), // ← fixed
  endsAt: z.iso.datetime().optional().nullable(), // ← fixed
  bannerUrl: z.string().url().optional().nullable(),
  thumbnailUrl: z.string().url().optional().nullable(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  metaTitle: z.string().optional().nullable(),
  metaDescription: z.string().optional().nullable(),
  metaImageUrl: z.string().url().optional().nullable(),
});

export class UpdateCampaignDto extends createZodDto(updateCampaignSchema) {}

/* ══════════════ QUERY ══════════════ */
export const campaignQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
  status: campaignStatusEnum.optional(),
  isActive: z.preprocess((v) => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }, z.boolean().optional()),
  isFeatured: z.preprocess((v) => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }, z.boolean().optional()),
});
export class CampaignQueryDto extends createZodDto(campaignQuerySchema) {}
