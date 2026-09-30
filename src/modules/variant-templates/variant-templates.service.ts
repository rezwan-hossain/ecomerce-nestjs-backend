import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CreateVariantTemplateDto,
  UpdateVariantTemplateDto,
  VariantTemplateQueryDto,
} from './dto/variant-template.dto';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { VariantTemplateWhereInput } from 'src/generated/prisma/models/VariantTemplate';

type TemplateOptionInput = CreateVariantTemplateDto['options'];

const TEMPLATE_INCLUDE = {
  options: {
    include: {
      option: { select: { id: true, name: true } },
      values: {
        include: {
          optionValue: { select: { id: true, value: true } },
        },
      },
    },
  },
} as const;

@Injectable()
export class VariantTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────
  // CREATE TEMPLATE (ADMIN+)
  // ──────────────────────────────────────────────
  async create(dto: CreateVariantTemplateDto) {
    await this.validateTemplateOptions(dto.options);

    try {
      const template = await this.prisma.variantTemplate.create({
        data: {
          name: dto.name,
          description: dto.description,
          options: { create: this.buildOptionsCreate(dto.options) },
        },
        include: TEMPLATE_INCLUDE,
      });

      return {
        message: 'Variant template created successfully',
        data: template,
      };
    } catch (error) {
      this.handleUniqueNameError(error);
    }
  }

  // ──────────────────────────────────────────────
  // LIST TEMPLATES (Public)
  // ──────────────────────────────────────────────
  async findAll(query: VariantTemplateQueryDto) {
    const { page, limit, search } = query;
    const skip = (page - 1) * limit;

    const where: VariantTemplateWhereInput = {};

    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }

    const [templates, total] = await Promise.all([
      this.prisma.variantTemplate.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: TEMPLATE_INCLUDE,
      }),
      this.prisma.variantTemplate.count({ where }),
    ]);

    return {
      data: templates,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ──────────────────────────────────────────────
  // GET TEMPLATE BY ID (Public)
  // ──────────────────────────────────────────────
  async findOne(id: string) {
    const template = await this.prisma.variantTemplate.findUnique({
      where: { id },
      include: TEMPLATE_INCLUDE,
    });

    if (!template) {
      throw new NotFoundException(`Variant template with ID "${id}" not found`);
    }

    return { data: template };
  }

  // ──────────────────────────────────────────────
  // UPDATE TEMPLATE (ADMIN+)
  // `options`, when provided, fully replaces the existing option set.
  // ──────────────────────────────────────────────
  async update(id: string, dto: UpdateVariantTemplateDto) {
    await this.ensureExists(id);

    if (dto.options) {
      await this.validateTemplateOptions(dto.options);
    }

    try {
      const template = await this.prisma.variantTemplate.update({
        where: { id },
        data: {
          ...(dto.name && { name: dto.name }),
          ...(dto.description !== undefined && {
            description: dto.description,
          }),
          ...(dto.options && {
            options: {
              deleteMany: {},
              create: this.buildOptionsCreate(dto.options),
            },
          }),
        },
        include: TEMPLATE_INCLUDE,
      });

      return {
        message: 'Variant template updated successfully',
        data: template,
      };
    } catch (error) {
      this.handleUniqueNameError(error);
    }
  }

  // ──────────────────────────────────────────────
  // DELETE TEMPLATE (ADMIN+)
  // ──────────────────────────────────────────────
  async remove(id: string) {
    await this.ensureExists(id);

    await this.prisma.variantTemplate.delete({
      where: { id },
    });

    return { message: 'Variant template deleted successfully' };
  }

  // ──────────────────────────────────────────────
  // HELPER METHODS
  // ──────────────────────────────────────────────
  private async ensureExists(id: string) {
    const exists = await this.prisma.variantTemplate.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!exists) {
      throw new NotFoundException(`Variant template with ID "${id}" not found`);
    }
  }

  /** Checks every option exists and every value belongs to its declared option.
   * Duplicate ids are already rejected by the DTO schema. */
  private async validateTemplateOptions(options: TemplateOptionInput) {
    const optionIds = options.map((o) => o.optionId);

    const optionCount = await this.prisma.option.count({
      where: { id: { in: optionIds } },
    });
    if (optionCount !== optionIds.length) {
      throw new BadRequestException(
        `Some options not found. Provided: ${optionIds.length}, Found: ${optionCount}`,
      );
    }

    const allValueIds = options.flatMap((o) => o.optionValueIds);
    const dbValues = await this.prisma.optionValue.findMany({
      where: { id: { in: allValueIds } },
      select: { id: true, optionId: true },
    });

    if (dbValues.length !== allValueIds.length) {
      const foundIds = new Set(dbValues.map((v) => v.id));
      const missing = allValueIds.filter((id) => !foundIds.has(id));
      throw new BadRequestException(
        `Option values not found: ${missing.join(', ')}`,
      );
    }

    const valueToOption = new Map(dbValues.map((v) => [v.id, v.optionId]));
    for (const { optionId, optionValueIds } of options) {
      const mismatched = optionValueIds.filter(
        (valueId) => valueToOption.get(valueId) !== optionId,
      );
      if (mismatched.length) {
        throw new BadRequestException(
          `Option values ${mismatched.join(', ')} do not belong to option ${optionId}`,
        );
      }
    }
  }

  private buildOptionsCreate(options: TemplateOptionInput) {
    return options.map((o) => ({
      optionId: o.optionId,
      values: {
        create: o.optionValueIds.map((optionValueId) => ({ optionValueId })),
      },
    }));
  }

  private handleUniqueNameError(error: unknown): never {
    if (
      error instanceof PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        'Variant template with this name already exists',
      );
    }
    throw error;
  }
}
