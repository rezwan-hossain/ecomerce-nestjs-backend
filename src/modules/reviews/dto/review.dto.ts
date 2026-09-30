import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   REVIEW SCHEMAS & DTOS
   ----------------------------------------
   No auth module exists yet, so the reviewer is identified by a `userId`
   query param (same placeholder as carts/orders). Swap it for
   `@Req().user.id` once an auth guard lands.
   ========================================== */

const rating = z.coerce.number().int().min(1).max(5);

export const reviewerQuerySchema = z.object({
  userId: z.string().uuid(),
});

export class ReviewerQueryDto extends createZodDto(reviewerQuerySchema) {}

export const createReviewSchema = z.object({
  productId: z.string().uuid(),
  rating,
  title: z.string().trim().min(1).max(150).optional(),
  body: z.string().trim().min(1).max(5000).optional(),
});

export class CreateReviewDto extends createZodDto(createReviewSchema) {}

// Author edits. `null` clears title/body.
export const updateReviewSchema = z
  .object({
    rating: rating.optional(),
    title: z.string().trim().min(1).max(150).nullable().optional(),
    body: z.string().trim().min(1).max(5000).nullable().optional(),
  })
  .refine((dto) => Object.values(dto).some((v) => v !== undefined), {
    message: 'Provide at least one of rating, title or body',
  });

export class UpdateReviewDto extends createZodDto(updateReviewSchema) {}

// Admin moderation
export const moderateReviewSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
});

export class ModerateReviewDto extends createZodDto(moderateReviewSchema) {}

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
};

// Admin listing — any status
export const reviewQuerySchema = z.object({
  ...pagination,
  productId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  rating: rating.optional(),
});

export class ReviewQueryDto extends createZodDto(reviewQuerySchema) {}

// Public product listing — approved reviews only
export const productReviewQuerySchema = z.object({
  ...pagination,
  rating: rating.optional(),
  sort: z.enum(['newest', 'highest', 'lowest']).default('newest'),
});

export class ProductReviewQueryDto extends createZodDto(
  productReviewQuerySchema,
) {}
