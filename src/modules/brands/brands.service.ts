import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateBrandDto, UpdateBrandDto, BrandQueryDto } from './dto/brand.dto';
import { BrandWhereInput } from 'src/generated/prisma/models/Brand';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';




@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────────────────────────────────
  // CREATE BRAND
  // ──────────────────────────────────────────────────────────────────────────
  async create(dto: CreateBrandDto) {
    try {
      const brand = await this.prisma.brand.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          logoUrl: dto.logoUrl || null,
        },
      });

      return {
        message: 'Brand created successfully',
        data: brand,
      };
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const field = (error.meta?.target as string[])?.join(', ') ?? 'field';
        throw new ConflictException(`Brand with this ${field} already exists`);
      }
      throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // LIST BRANDS (Public with Pagination & Search)
  // ──────────────────────────────────────────────────────────────────────────
  async findAll(query: BrandQueryDto) {
    const { page, limit, search } = query;
    const skip = (page - 1) * limit;

    const where: BrandWhereInput = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [brands, total] = await Promise.all([
      this.prisma.brand.findMany({
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
      this.prisma.brand.count({ where }),
    ]);

    return {
      data: brands,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // FIND ONE BY ID
  // ──────────────────────────────────────────────────────────────────────────
  async findOne(id: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id },
      include: {
        _count: {
          select: { products: true },
        },
      },
    });

    if (!brand) {
      throw new NotFoundException(`Brand with ID "${id}" not found`);
    }

    return { data: brand };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // FIND ONE BY SLUG
  // ──────────────────────────────────────────────────────────────────────────
  async findBySlug(slug: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { slug },
      include: {
        _count: {
          select: { products: true },
        },
      },
    });

    if (!brand) {
      throw new NotFoundException(`Brand with slug "${slug}" not found`);
    }

    return { data: brand };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // UPDATE BRAND
  // ──────────────────────────────────────────────────────────────────────────
  async update(id: string, dto: UpdateBrandDto) {
    await this.ensureExists(id);

    try {
      const brand = await this.prisma.brand.update({
        where: { id },
        data: {
          ...(dto.name && { name: dto.name }),
          ...(dto.slug && { slug: dto.slug }),
          ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl || null }),
        },
      });

      return {
        message: 'Brand updated successfully',
        data: brand,
      };
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const field = (error.meta?.target as string[])?.join(', ') ?? 'field';
        throw new ConflictException(`Brand with this ${field} already exists`);
      }
      throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE BRAND
  // ──────────────────────────────────────────────────────────────────────────
  async remove(id: string) {
    await this.ensureExists(id);

    await this.prisma.brand.delete({
      where: { id },
    });

    return { message: 'Brand deleted successfully' };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // HELPER METHOD
  // ──────────────────────────────────────────────────────────────────────────
  private async ensureExists(id: string) {
    const exists = await this.prisma.brand.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!exists) {
      throw new NotFoundException(`Brand with ID "${id}" not found`);
    }
  }
}
