import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CreateOptionDto,
  UpdateOptionDto,
  OptionQueryDto,
} from './dto/option.dto';
import {
  CreateOptionValueDto,
  UpdateOptionValueDto,
} from './dto/option-value.dto';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { OptionWhereInput } from 'src/generated/prisma/models/Option';

@Injectable()
export class OptionsService {
  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────
  // CREATE OPTION (ADMIN+)
  // ──────────────────────────────────────────────
  async create(dto: CreateOptionDto) {
    try {
      const option = await this.prisma.option.create({
        data: {
          name: dto.name,
        },
      });

      return {
        message: 'Option created successfully',
        data: option,
      };
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Option with this name already exists');
      }
      throw error;
    }
  }

  // ──────────────────────────────────────────────
  // LIST OPTIONS (Public)
  // ──────────────────────────────────────────────
  async findAll(query: OptionQueryDto) {
    const { page, limit, search } = query;
    const skip = (page - 1) * limit;

    const where: OptionWhereInput = {};

    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }

    const [options, total] = await Promise.all([
      this.prisma.option.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          values: true,
          _count: {
            select: { productOptions: true },
          },
        },
      }),
      this.prisma.option.count({ where }),
    ]);

    return {
      data: options,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ──────────────────────────────────────────────
  // GET OPTION BY ID (Public)
  // ──────────────────────────────────────────────
  async findOne(id: string) {
    const option = await this.prisma.option.findUnique({
      where: { id },
      include: {
        values: true,
        _count: {
          select: { productOptions: true },
        },
      },
    });

    if (!option) {
      throw new NotFoundException(`Option with ID "${id}" not found`);
    }

    return { data: option };
  }

  // ──────────────────────────────────────────────
  // UPDATE OPTION (ADMIN+)
  // ──────────────────────────────────────────────
  async update(id: string, dto: UpdateOptionDto) {
    await this.ensureExists(id);

    try {
      const option = await this.prisma.option.update({
        where: { id },
        data: {
          ...(dto.name && { name: dto.name }),
        },
      });

      return {
        message: 'Option updated successfully',
        data: option,
      };
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Option with this name already exists');
      }
      throw error;
    }
  }

  // ──────────────────────────────────────────────
  // DELETE OPTION (ADMIN+)
  // ──────────────────────────────────────────────
  async remove(id: string) {
    await this.ensureExists(id);

    await this.prisma.option.delete({
      where: { id },
    });

    return { message: 'Option deleted successfully' };
  }

  // ──────────────────────────────────────────────
  // ADD OPTION VALUE (ADMIN+)
  // ──────────────────────────────────────────────
  async addValue(optionId: string, dto: CreateOptionValueDto) {
    await this.ensureExists(optionId);

    try {
      const value = await this.prisma.optionValue.create({
        data: {
          optionId,
          value: dto.value,
        },
      });

      return {
        message: 'Option value created successfully',
        data: value,
      };
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('This value already exists for the option');
      }
      throw error;
    }
  }

  // ──────────────────────────────────────────────
  // UPDATE OPTION VALUE (ADMIN+)
  // ──────────────────────────────────────────────
  async updateValue(
    optionId: string,
    valueId: string,
    dto: UpdateOptionValueDto,
  ) {
    await this.ensureValueExists(optionId, valueId);

    try {
      const value = await this.prisma.optionValue.update({
        where: { id: valueId },
        data: {
          ...(dto.value && { value: dto.value }),
        },
      });

      return {
        message: 'Option value updated successfully',
        data: value,
      };
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('This value already exists for the option');
      }
      throw error;
    }
  }

  // ──────────────────────────────────────────────
  // DELETE OPTION VALUE (ADMIN+)
  // ──────────────────────────────────────────────
  async removeValue(optionId: string, valueId: string) {
    await this.ensureValueExists(optionId, valueId);

    await this.prisma.optionValue.delete({
      where: { id: valueId },
    });

    return { message: 'Option value deleted successfully' };
  }

  // ──────────────────────────────────────────────
  // HELPER METHODS
  // ──────────────────────────────────────────────
  private async ensureExists(id: string) {
    const exists = await this.prisma.option.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!exists) {
      throw new NotFoundException(`Option with ID "${id}" not found`);
    }
  }

  private async ensureValueExists(optionId: string, valueId: string) {
    const exists = await this.prisma.optionValue.findUnique({
      where: { id: valueId },
      select: { id: true, optionId: true },
    });

    if (!exists || exists.optionId !== optionId) {
      throw new NotFoundException(
        `Option value with ID "${valueId}" not found for this option`,
      );
    }
  }
}
