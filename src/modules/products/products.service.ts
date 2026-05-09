import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateProductDto } from './dto/product.dto';
import { createSlug, generateSlugWithUUID } from 'src/common/utils/slug.util';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  async createProduct(data: CreateProductDto) {
    const { slug: providedSlug, name, ...productData } = data;

    let slug = providedSlug ? createSlug(providedSlug) : createSlug(name);

    const existingslug = await this.prisma.product.findUnique({
      where: {
        slug,
      },
    });

    if (existingslug) {
      slug = generateSlugWithUUID(name);
    }

    return this.prisma.product.create({
      data: {
        ...productData,
        slug,
      },
    });
  }
}
