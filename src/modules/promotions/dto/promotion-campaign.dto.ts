import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const attachCampaignsSchema = z.object({
  campaignIds: z.array(z.string().uuid()).min(1),
});

export class AttachCampaignsDto extends createZodDto(attachCampaignsSchema) {}
