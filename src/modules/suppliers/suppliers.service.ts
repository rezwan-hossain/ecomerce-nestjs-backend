import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SupplierWhereInput } from 'src/generated/prisma/models/Supplier';
import {
  CreateSupplierDto,
  SupplierQueryDto,
  UpdateSupplierDto,
} from './dto/supplier.dto';

const SUPPLIER_COUNTS = {
  _count: { select: { batches: true, purchaseOrders: true } },
} as const;

@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateSupplierDto) {
    try {
      const supplier = await this.prisma.supplier.create({ data: dto });
      return { message: 'Supplier created successfully', data: supplier };
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  async findAll(query: SupplierQueryDto) {
    const { page, limit, search, isActive } = query;
    const where: SupplierWhereInput = {};
    if (isActive !== undefined) where.isActive = isActive;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { company: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [suppliers, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { name: 'asc' },
        include: SUPPLIER_COUNTS,
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return {
      data: suppliers,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** The supplier plus its 10 most recent batches (what it delivered). */
  async findOne(id: string) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        ...SUPPLIER_COUNTS,
        batches: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            variant: {
              select: {
                id: true,
                sku: true,
                product: { select: { id: true, name: true, slug: true } },
              },
            },
            warehouse: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return { data: supplier };
  }

  async update(id: string, dto: UpdateSupplierDto) {
    try {
      const supplier = await this.prisma.supplier.update({
        where: { id },
        data: dto,
      });
      return { message: 'Supplier updated successfully', data: supplier };
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  private handlePrismaError(error: unknown): never {
    if (error instanceof PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new ConflictException('Supplier with this code already exists');
      }
      if (error.code === 'P2025') {
        throw new NotFoundException('Supplier not found');
      }
    }
    throw error;
  }
}
