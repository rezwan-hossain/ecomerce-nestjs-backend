import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   STORAGE LOCATION (RACK) SCHEMAS & DTOS
   ========================================== */

export const locationTypeEnum = z.enum([
  'ZONE',
  'AISLE',
  'RACK',
  'SHELF',
  'BIN',
  'RECEIVING',
  'STAGING',
  'PACKING',
]);

// Codes are stored upper-case so "a-03" and "A-03" can't both exist.
const code = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, ".", "_" or "-"')
  .transform((c) => c.toUpperCase());

export const createLocationSchema = z.object({
  warehouseId: z.string().uuid().optional(), // defaults to the default warehouse
  code,
  name: z.string().trim().max(100).optional(),
  type: locationTypeEnum.default('RACK'),
  parentId: z.string().uuid().optional(),
  isPickable: z.boolean().default(true),
  pickSequence: z.number().int().nonnegative().default(0),
  note: z.string().trim().max(500).optional(),
});

export class CreateLocationDto extends createZodDto(createLocationSchema) {}

export const updateLocationSchema = z
  .object({
    code,
    name: z.string().trim().max(100).nullable(),
    type: locationTypeEnum,
    parentId: z.string().uuid().nullable(),
    isPickable: z.boolean(),
    isActive: z.boolean(),
    pickSequence: z.number().int().nonnegative(),
    note: z.string().trim().max(500).nullable(),
  })
  .partial();

export class UpdateLocationDto extends createZodDto(updateLocationSchema) {}

export const locationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  warehouseId: z.string().uuid().optional(),
  type: locationTypeEnum.optional(),
  parentId: z.string().uuid().optional(),
  search: z.string().trim().min(1).optional(), // code or name
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export class LocationQueryDto extends createZodDto(locationQuerySchema) {}
