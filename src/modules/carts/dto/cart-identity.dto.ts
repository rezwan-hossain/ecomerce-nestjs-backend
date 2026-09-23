import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   IDENTITY RESOLUTION
   ----------------------------------------
   No auth module exists yet. Carts are resolved by an authenticated
   userId (query param today; swap for `@Req().user.id` once a real
   auth guard lands — nothing below the controller needs to change)
   and/or a client-generated `x-session-id` header for guests.
   ========================================== */

export const cartIdentityQuerySchema = z.object({
  userId: z.string().uuid().optional(),
});

export class CartIdentityQueryDto extends createZodDto(
  cartIdentityQuerySchema,
) {}

// Merge target must be an authenticated user — userId is required here.
export const mergeCartQuerySchema = z.object({
  userId: z.string().uuid(),
});

export class MergeCartQueryDto extends createZodDto(mergeCartQuerySchema) {}
