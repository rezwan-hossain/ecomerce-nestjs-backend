import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   SUPPLIER SCHEMAS & DTOS
   ========================================== */

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const createSupplierSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(30)
    .regex(/^[A-Z0-9-]+$/, {
      message: 'Code must contain only uppercase letters, digits and hyphens',
    })
    .meta({ example: 'SUP-003' }),
  name: z
    .string()
    .trim()
    .min(2)
    .max(150)
    .meta({ example: 'Bengal Leather Co.' }),
  contactName: optionalText(100),
  contactEmail: z.string().trim().email().optional(),
  contactPhone: optionalText(30),
  company: optionalText(150),
  website: z.string().url().optional(),
  addressLine1: optionalText(255),
  addressLine2: optionalText(255),
  city: optionalText(100),
  state: optionalText(100),
  postalCode: optionalText(20),
  country: optionalText(100).meta({ example: 'BD' }),
  paymentTerms: optionalText(50).meta({ example: 'Net 30' }),
  leadTimeDays: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional().default(true),
  note: optionalText(1000),
});

export class CreateSupplierDto extends createZodDto(createSupplierSchema) {}

// Partial schema for PATCH requests (set isActive: false to retire one)
export const updateSupplierSchema = createSupplierSchema.partial();

export class UpdateSupplierDto extends createZodDto(updateSupplierSchema) {}

export const supplierQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(), // name, code or company
  isActive: z.preprocess((v) => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }, z.boolean().optional()),
});

export class SupplierQueryDto extends createZodDto(supplierQuerySchema) {}
