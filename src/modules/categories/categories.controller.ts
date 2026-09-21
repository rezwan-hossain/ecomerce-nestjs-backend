import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { CategoriesService } from './categories.service';

import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryQueryDto,
} from './dto/categories.dto';
import {
  ReorderCategoriesDto,
  MoveCategoryDto,
} from './dto/category-reorder.dto';

@Controller('categories')
@UsePipes(ZodValidationPipe)
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  /* ═════════════ CRUD ═════════════ */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  @Get()
  findAll(@Query() query: CategoryQueryDto) {
    return this.categoriesService.findAll(query);
  }

  @Get('tree')
  getTree() {
    return this.categoriesService.getCategoryTree();
  }

  @Get('slug/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.categoriesService.findBySlug(slug);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(id, dto);
  }

  @Patch(':id/move')
  move(@Param('id') id: string, @Body() dto: MoveCategoryDto) {
    return this.categoriesService.move(id, dto);
  }

  @Patch(':id/toggle-active')
  toggleActive(@Param('id') id: string) {
    return this.categoriesService.toggleActive(id);
  }

  @Patch('reorder')
  reorder(@Body() dto: ReorderCategoriesDto) {
    return this.categoriesService.reorder(dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.categoriesService.remove(id);
  }

  @Delete(':id/cascade')
  removeCascade(@Param('id') id: string) {
    return this.categoriesService.removeCascade(id);
  }

  /* ═════════════ CATEGORY PRODUCTS ═════════════ */
  @Get(':id/products')
  listProducts(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.categoriesService.listCategoryProducts(id, {
      page: page ? +page : undefined,
      limit: limit ? +limit : undefined,
    });
  }
}
