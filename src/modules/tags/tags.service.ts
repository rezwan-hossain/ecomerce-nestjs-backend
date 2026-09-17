import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateTagDto, UpdateTagDto, TagQueryDto } from './dto/tag.dto';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { TagWhereInput } from 'src/generated/prisma/models/Tag';

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────
  // CREATE TAG (ADMIN+)
  // ──────────────────────────────────────────────
  async create(dto: CreateTagDto) {
    try {
      const tag = await this.prisma.tag.create({
        data: {
          name: dto.name,
          slug: dto.slug,
        },
      });

      return {
        message: 'Tag created successfully',
        data: tag,
      };
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const field = (error.meta?.target as string[])?.join(', ') ?? 'field';
        throw new ConflictException(`Tag with this ${field} already exists`);
      }
      throw error;
    }
  }

  // ──────────────────────────────────────────────
  // LIST TAGS (Public)
  // ──────────────────────────────────────────────
  async findAll(query: TagQueryDto) {
    const { page, limit, search } = query;
    const skip = (page - 1) * limit;

    const where: TagWhereInput = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [tags, total] = await Promise.all([
      this.prisma.tag.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { products: true },
          },
        },
      }),
      this.prisma.tag.count({ where }),
    ]);

    return {
      data: tags,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ──────────────────────────────────────────────
  // GET TAG BY ID (Public)
  // ──────────────────────────────────────────────
  async findOne(id: string) {
    const tag = await this.prisma.tag.findUnique({
      where: { id },
      include: {
        _count: {
          select: { products: true },
        },
      },
    });

    if (!tag) {
      throw new NotFoundException(`Tag with ID "${id}" not found`);
    }

    return { data: tag };
  }

  // ──────────────────────────────────────────────
  // UPDATE TAG (ADMIN+)
  // ──────────────────────────────────────────────
  async update(id: string, dto: UpdateTagDto) {
    await this.ensureExists(id);

    try {
      const tag = await this.prisma.tag.update({
        where: { id },
        data: {
          ...(dto.name && { name: dto.name }),
          ...(dto.slug && { slug: dto.slug }),
        },
      });

      return {
        message: 'Tag updated successfully',
        data: tag,
      };
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const field = (error.meta?.target as string[])?.join(', ') ?? 'field';
        throw new ConflictException(`Tag with this ${field} already exists`);
      }
      throw error;
    }
  }

  // ──────────────────────────────────────────────
  // DELETE TAG (ADMIN+)
  // ──────────────────────────────────────────────
  async remove(id: string) {
    await this.ensureExists(id);

    await this.prisma.tag.delete({
      where: { id },
    });

    return { message: 'Tag deleted successfully' };
  }

  // ──────────────────────────────────────────────
  // HELPER METHOD
  // ──────────────────────────────────────────────
  private async ensureExists(id: string) {
    const exists = await this.prisma.tag.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!exists) {
      throw new NotFoundException(`Tag with ID "${id}" not found`);
    }
  }
}
