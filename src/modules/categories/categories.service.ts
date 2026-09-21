import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { CategoryWhereInput } from 'src/generated/prisma/models/Category';

import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryQueryDto,
} from './dto/categories.dto';
import {
  ReorderCategoriesDto,
  MoveCategoryDto,
} from './dto/category-reorder.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  // ═════════════════════════════════════════════════
  //   CREATE
  // ═════════════════════════════════════════════════

  async create(dto: CreateCategoryDto) {
    // Ensure parent exists and is active if provided
    if (dto.parentId) {
      await this.ensureCategoryExistsAndActive(dto.parentId);
    }

    try {
      const category = await this.prisma.category.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          parentId: dto.parentId ?? null,
          isActive: dto.isActive ?? true,
          position: dto.position ?? 0,
        },
        include: {
          parent: { select: { id: true, name: true, slug: true } },
        },
      });

      return { message: 'Category created successfully', data: category };
    } catch (error) {
      this.handlePrismaError(error, 'Category');
    }
  }

  // ═════════════════════════════════════════════════
  //   LIST (flat or tree)
  // ═════════════════════════════════════════════════

  async findAll(query: CategoryQueryDto) {
    const {
      page = 1,
      limit = 20,
      search,
      parentId,
      isActive,
      includeTree,
    } = query;

    if (includeTree) {
      return this.getCategoryTree();
    }

    const skip = (page - 1) * limit;

    const where: CategoryWhereInput = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
      ];
    }

    // parentId=null → filter to root categories
    if (parentId === 'null') {
      where.parentId = null;
    } else if (parentId) {
      where.parentId = parentId;
    }

    if (isActive !== undefined) where.isActive = isActive;

    const [items, total] = await Promise.all([
      this.prisma.category.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        include: {
          parent: { select: { id: true, name: true, slug: true } },
          _count: {
            select: { products: true, children: true, campaignRules: true },
          },
        },
      }),
      this.prisma.category.count({ where }),
    ]);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  // ═════════════════════════════════════════════════
  //   TREE (nested hierarchy)
  // ═════════════════════════════════════════════════

  async getCategoryTree() {
    const rootCategories = await this.prisma.category.findMany({
      where: { parentId: null },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      include: {
        children: {
          orderBy: [{ position: 'asc' }, { name: 'asc' }],
          include: {
            children: {
              orderBy: [{ position: 'asc' }, { name: 'asc' }],
              include: {
                children: {
                  orderBy: [{ position: 'asc' }, { name: 'asc' }],
                  include: {
                    _count: { select: { products: true } },
                  },
                },
                _count: { select: { products: true, children: true } },
              },
            },
            _count: { select: { products: true, children: true } },
          },
        },
        _count: { select: { products: true, children: true } },
      },
    });

    return { data: rootCategories };
  }

  // ═════════════════════════════════════════════════
  //   FIND ONE (by ID)
  // ═════════════════════════════════════════════════

  async findOne(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: {
        parent: { select: { id: true, name: true, slug: true } },
        children: {
          orderBy: [{ position: 'asc' }, { name: 'asc' }],
          include: {
            _count: { select: { products: true, children: true } },
          },
        },
        _count: {
          select: {
            products: true,
            children: true,
            campaignRules: true,
            promotionTargets: true,
          },
        },
      },
    });

    if (!category) {
      throw new NotFoundException(`Category "${id}" not found`);
    }

    // Include breadcrumb chain from root to this category
    const breadcrumb = await this.getBreadcrumb(id);

    return { data: { ...category, breadcrumb } };
  }

  // ═════════════════════════════════════════════════
  //   FIND BY SLUG
  // ═════════════════════════════════════════════════

  async findBySlug(slug: string) {
    const category = await this.prisma.category.findUnique({
      where: { slug },
      include: {
        parent: { select: { id: true, name: true, slug: true } },
        children: {
          where: { isActive: true },
          orderBy: [{ position: 'asc' }, { name: 'asc' }],
        },
        _count: { select: { products: true, children: true } },
      },
    });

    if (!category) {
      throw new NotFoundException(`Category slug "${slug}" not found`);
    }

    const breadcrumb = await this.getBreadcrumb(category.id);

    return { data: { ...category, breadcrumb } };
  }

  // ═════════════════════════════════════════════════
  //   UPDATE
  // ═════════════════════════════════════════════════

  async update(id: string, dto: UpdateCategoryDto) {
    const current = await this.ensureCategoryExists(id);

    // Validate parent change
    if (dto.parentId !== undefined && dto.parentId !== current.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('A category cannot be its own parent');
      }

      if (dto.parentId) {
        await this.ensureCategoryExistsAndActive(dto.parentId);
        // Prevent creating a cyclic tree (parent cannot be a descendant)
        await this.assertNotDescendant(id, dto.parentId);
      }
    }

    try {
      const category = await this.prisma.category.update({
        where: { id },
        data: {
          ...(dto.name && { name: dto.name }),
          ...(dto.slug && { slug: dto.slug }),
          ...(dto.parentId !== undefined && { parentId: dto.parentId ?? null }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(dto.position !== undefined && { position: dto.position }),
        },
        include: {
          parent: { select: { id: true, name: true, slug: true } },
        },
      });

      return { message: 'Category updated', data: category };
    } catch (error) {
      this.handlePrismaError(error, 'Category');
    }
  }

  // ═════════════════════════════════════════════════
  //   MOVE (change parent + position)
  // ═════════════════════════════════════════════════

  async move(id: string, dto: MoveCategoryDto) {
    const current = await this.ensureCategoryExists(id);

    if (dto.newParentId === id) {
      throw new BadRequestException('A category cannot be its own parent');
    }

    if (dto.newParentId) {
      await this.ensureCategoryExistsAndActive(dto.newParentId);
      await this.assertNotDescendant(id, dto.newParentId);
    }

    try {
      const category = await this.prisma.category.update({
        where: { id },
        data: {
          parentId: dto.newParentId ?? null,
          ...(dto.position !== undefined && { position: dto.position }),
        },
      });

      return { message: 'Category moved', data: category };
    } catch (error) {
      this.handlePrismaError(error, 'Category');
    }
  }

  // ═════════════════════════════════════════════════
  //   REORDER (bulk position update)
  // ═════════════════════════════════════════════════

  async reorder(dto: ReorderCategoriesDto) {
    const ids = dto.items.map((i) => i.id);

    const existing = await this.prisma.category.findMany({
      where: { id: { in: ids } },
      select: { id: true, parentId: true },
    });

    if (existing.length !== ids.length) {
      throw new BadRequestException('One or more categories do not exist');
    }

    // Ensure all reordered categories share the same parent
    const parentSet = new Set(existing.map((c) => c.parentId ?? 'root'));
    if (parentSet.size > 1) {
      throw new BadRequestException(
        'All reordered categories must belong to the same parent',
      );
    }

    await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.category.update({
          where: { id: item.id },
          data: { position: item.position },
        }),
      ),
    );

    return { message: 'Categories reordered' };
  }

  // ═════════════════════════════════════════════════
  //   TOGGLE ACTIVE
  // ═════════════════════════════════════════════════

  async toggleActive(id: string) {
    const current = await this.ensureCategoryExists(id);

    const updated = await this.prisma.category.update({
      where: { id },
      data: { isActive: !current.isActive },
    });

    return {
      message: `Category ${updated.isActive ? 'activated' : 'deactivated'}`,
      data: updated,
    };
  }

  // ═════════════════════════════════════════════════
  //   DELETE
  // ═════════════════════════════════════════════════

  async remove(id: string) {
    const current = await this.ensureCategoryExists(id);

    // Check for children
    const childCount = await this.prisma.category.count({
      where: { parentId: id },
    });

    if (childCount > 0) {
      throw new BadRequestException(
        `Cannot delete category with ${childCount} child categories. Move or delete children first.`,
      );
    }

    // Check for linked products
    const productCount = await this.prisma.productCategory.count({
      where: { categoryId: id },
    });

    if (productCount > 0) {
      throw new BadRequestException(
        `Cannot delete category with ${productCount} linked products. Unlink products first.`,
      );
    }

    try {
      await this.prisma.category.delete({ where: { id } });
    } catch (error) {
      this.handlePrismaError(error, 'Category');
    }

    return { message: 'Category deleted successfully' };
  }

  /**
   * Cascade delete: removes category and all its descendants.
   * Category-Product links auto-cascade (schema onDelete: Cascade).
   */
  async removeCascade(id: string) {
    await this.ensureCategoryExists(id);

    const descendants = await this.getAllDescendantIds(id);
    const allIds = [id, ...descendants];

    await this.prisma.$transaction([
      this.prisma.category.deleteMany({
        where: { id: { in: allIds } },
      }),
    ]);

    return {
      message: `Category and ${descendants.length} descendants deleted`,
      deletedIds: allIds,
    };
  }

  // ═════════════════════════════════════════════════
  //   PRODUCTS UNDER CATEGORY
  // ═════════════════════════════════════════════════

  async listCategoryProducts(id: string, query: { page?: number; limit?: number }) {
    await this.ensureCategoryExists(id);

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    // Include descendant category IDs for deep listing
    const descendantIds = await this.getAllDescendantIds(id);
    const categoryIds = [id, ...descendantIds];

    const [items, total] = await Promise.all([
      this.prisma.productCategory.findMany({
        where: { categoryId: { in: categoryIds } },
        skip,
        take: limit,
        orderBy: { assignedAt: 'desc' },
        include: {
          product: {
            include: {
              images: { where: { isPrimary: true }, take: 1 },
              brand: true,
              variants: { where: { isActive: true }, take: 1 },
            },
          },
          category: { select: { id: true, name: true, slug: true } },
        },
      }),
      this.prisma.productCategory.count({
        where: { categoryId: { in: categoryIds } },
      }),
    ]);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  // ═════════════════════════════════════════════════
  //   HELPERS
  // ═════════════════════════════════════════════════

  private async ensureCategoryExists(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      select: {
        id: true,
        parentId: true,
        isActive: true,
      },
    });

    if (!category) {
      throw new NotFoundException(`Category "${id}" not found`);
    }

    return category;
  }

  private async ensureCategoryExistsAndActive(id: string) {
    const category = await this.ensureCategoryExists(id);

    if (!category.isActive) {
      throw new BadRequestException(
        `Category "${id}" is inactive and cannot be used`,
      );
    }

    return category;
  }

  /**
   * Get all descendant category IDs recursively.
   */
  private async getAllDescendantIds(rootId: string): Promise<string[]> {
    const result: string[] = [];
    const queue: string[] = [rootId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = await this.prisma.category.findMany({
        where: { parentId: currentId },
        select: { id: true },
      });

      for (const child of children) {
        result.push(child.id);
        queue.push(child.id);
      }
    }

    return result;
  }

  /**
   * Ensures the candidate parent isn't a descendant of `id` (prevents cycles).
   */
  private async assertNotDescendant(id: string, candidateParentId: string) {
    const descendants = await this.getAllDescendantIds(id);

    if (descendants.includes(candidateParentId)) {
      throw new BadRequestException(
        'Cannot set parent to one of its own descendants (cycle detected)',
      );
    }
  }

  /**
   * Build breadcrumb chain from root down to the given category.
   */
  private async getBreadcrumb(id: string) {
    const breadcrumb: { id: string; name: string; slug: string }[] = [];
    let currentId: string | null = id;

    while (currentId) {
      const cat = await this.prisma.category.findUnique({
        where: { id: currentId },
        select: { id: true, name: true, slug: true, parentId: true },
      });

      if (!cat) break;

      breadcrumb.unshift({ id: cat.id, name: cat.name, slug: cat.slug });
      currentId = cat.parentId;
    }

    return breadcrumb;
  }

  private handlePrismaError(error: unknown, entity: string): never {
    if (error instanceof PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        const target = error.meta?.target;
        const field = Array.isArray(target)
          ? target.join(', ')
          : typeof target === 'string'
            ? target
            : 'field';

        throw new ConflictException(
          `${entity} with this ${field} already exists`,
        );
      }

      if (error.code === 'P2025') {
        throw new NotFoundException(`${entity} not found`);
      }

      if (error.code === 'P2003') {
        throw new BadRequestException(`${entity} reference constraint failed`);
      }
    }

    if (
      error instanceof NotFoundException ||
      error instanceof ConflictException ||
      error instanceof BadRequestException
    ) {
      throw error;
    }

    throw error;
  }
}
