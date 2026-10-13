import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { pagination } from './inventory.dto';

/* ==========================================
   WAREHOUSE SCHEMAS & DTOS
   ========================================== */

export const warehouseTypeEnum = z.enum([
  'PHYSICAL',
  'STORE',
  'VIRTUAL_DAMAGE',
  'VIRTUAL_QC',
  'VIRTUAL_RETURN',
]);

const nullableText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

const editable = {
  name: z.string().trim().min(2).max(100).meta({ example: 'Dhaka Main' }),
  type: warehouseTypeEnum,
  addressLine1: nullableText(255),
  addressLine2: nullableText(255),
  city: nullableText(100),
  state: nullableText(100), // division
  postalCode: nullableText(20),
  priority: z.number().int().min(0).max(1000), // reserved from first when higher
  isDefault: z.boolean(),
  isActive: z.boolean(),
};

export const createWarehouseSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(20)
    .regex(/^[A-Z0-9-]+$/, {
      message: 'Code must contain only uppercase letters, digits and hyphens',
    })
    .meta({ example: 'DHK-01' }),
  ...editable,
  type: editable.type.default('PHYSICAL'),
  priority: editable.priority.default(0),
  isDefault: editable.isDefault.default(false),
  isActive: editable.isActive.default(true),
});

export class CreateWarehouseDto extends createZodDto(createWarehouseSchema) {}

export const updateWarehouseSchema = z.object({
  // Racks and documents show the code, so it's fixed after create.
  code: z
    .never({ error: "code can't be changed after the warehouse is created" })
    .optional(),
  name: editable.name.optional(),
  type: editable.type.optional(),
  addressLine1: editable.addressLine1,
  addressLine2: editable.addressLine2,
  city: editable.city,
  state: editable.state,
  postalCode: editable.postalCode,
  priority: editable.priority.optional(),
  isDefault: editable.isDefault.optional(),
  isActive: editable.isActive.optional(),
});

export class UpdateWarehouseDto extends createZodDto(updateWarehouseSchema) {}

export const warehouseStockQuerySchema = z.object({
  ...pagination,
  search: z.string().trim().min(1).optional(), // SKU or product name
});

export class WarehouseStockQueryDto extends createZodDto(
  warehouseStockQuerySchema,
) {}
