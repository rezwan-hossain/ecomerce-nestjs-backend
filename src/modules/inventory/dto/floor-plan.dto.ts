import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  MAX_BINS_PER_LEVEL,
  MAX_LEVELS,
  RACK_CODE_PATTERN,
} from '../floor-plan/rack-layout';

/* ==========================================
   RACK MAP (FLOOR PLAN) SCHEMAS & DTOS
   Coordinates are metres; Decimal(8,2) in the database.
   ========================================== */

const MAX_METRES = 10_000;

const metres = z.number().nonnegative().max(MAX_METRES);
const size = z.number().positive().max(MAX_METRES);

export const rotationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);

export const placementSchema = z.object({
  centerX: metres,
  centerY: metres,
  length: size,
  depth: size,
  rotation: rotationSchema,
});

// GET /inventory/warehouses/:warehouseId/floor-plan
export const floorPlanQuerySchema = z.object({
  activityDays: z.coerce.number().int().min(1).max(365).default(30),
});
export class FloorPlanQueryDto extends createZodDto(floorPlanQuerySchema) {}

// PUT /inventory/warehouses/:warehouseId/floor-size
export const floorSizeSchema = z.object({
  floorWidth: size,
  floorDepth: size,
});
export class FloorSizeDto extends createZodDto(floorSizeSchema) {}

// PATCH /inventory/locations/:locationId/placement
// Either a full Placement or { remove: true }. (One object rather than a
// union, which createZodDto can't turn into a class.)
export const placementBodySchema = placementSchema
  .partial()
  .extend({ remove: z.literal(true).optional() })
  .superRefine((body, ctx) => {
    const fields = [
      'centerX',
      'centerY',
      'length',
      'depth',
      'rotation',
    ] as const;
    const given = fields.filter((f) => body[f] !== undefined);
    if (body.remove) {
      if (given.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'Send either { remove: true } or a placement, not both',
        });
      }
      return;
    }
    for (const f of fields) {
      if (body[f] === undefined) {
        ctx.addIssue({ code: 'custom', path: [f], message: 'Required' });
      }
    }
  });
export class PlacementBodyDto extends createZodDto(placementBodySchema) {}

// POST /inventory/locations/:locationId/rotate
export const rotateSchema = z.object({
  direction: z.enum(['cw', 'ccw', '180']),
});
export class RotateDto extends createZodDto(rotateSchema) {}

// POST /inventory/warehouses/:warehouseId/racks
export const createRackSchema = z.object({
  code: z
    .string()
    .trim()
    .transform((c) => c.toUpperCase())
    .pipe(
      z
        .string()
        .regex(
          RACK_CODE_PATTERN,
          'Use 1-10 letters, digits or "-", starting with a letter or digit',
        ),
    ),
  name: z.string().trim().max(100).optional(),
  zoneId: z.string().uuid().optional(),
  levels: z.number().int().min(1).max(MAX_LEVELS),
  binsPerLevel: z.number().int().min(1).max(MAX_BINS_PER_LEVEL),
  rotation: rotationSchema,
  length: size.optional(), // default binsPerLevel × 1.4 m
  depth: size.optional(), // default 1.2 m
  placement: placementSchema.optional(), // default: first free spot
});
export class CreateRackDto extends createZodDto(createRackSchema) {}

// GET /inventory/warehouses/:warehouseId/pick-route
export const pickRouteQuerySchema = z.object({
  orderId: z.string().uuid().optional(),
});
export class PickRouteQueryDto extends createZodDto(pickRouteQuerySchema) {}
