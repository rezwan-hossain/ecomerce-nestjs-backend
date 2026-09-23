import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { ProductsService } from './products.service';

import {
  CreateProductDto,
  UpdateProductDto,
  ProductQueryDto,
} from './dto/product.dto';
import {
  AddProductImagesDto,
  UpdateProductImageDto,
  ReorderProductImagesDto,
} from './dto/product-image.dto';
import {
  AddVariantDto,
  UpdateVariantDto,
  AdjustStockDto,
} from './dto/product-variant.dto';

@Controller('products')
@UsePipes(ZodValidationPipe)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  /* ═════════════ CRUD ═════════════ */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateProductDto) {
    return this.productsService.createProduct(dto);
  }

  @Get()
  findAll(@Query() query: ProductQueryDto) {
    return this.productsService.findAll(query);
  }

  @Get('slug/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.productsService.findOneBySlug(slug);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    // Support UUID or slug fallback
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
    return isUuid
      ? this.productsService.findOneById(id)
      : this.productsService.findOneBySlug(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.updateProduct(id, dto);
  }

  /* ═════════════ STATUS TRANSITIONS ═════════════ */
  @Patch(':id/publish')
  publish(@Param('id') id: string) {
    return this.productsService.publish(id);
  }

  @Patch(':id/archive')
  archive(@Param('id') id: string) {
    return this.productsService.archive(id);
  }

  @Patch(':id/unarchive')
  unarchive(@Param('id') id: string) {
    return this.productsService.unarchive(id);
  }

  /* ═════════════ DELETE ═════════════ */
  @Delete(':id')
  softDelete(@Param('id') id: string) {
    return this.productsService.softDelete(id);
  }

  @Delete(':id/permanent')
  hardDelete(@Param('id') id: string) {
    return this.productsService.hardDelete(id);
  }

  /* ═════════════ IMAGES ═════════════ */
  @Post(':id/images')
  addImages(@Param('id') id: string, @Body() dto: AddProductImagesDto) {
    return this.productsService.addProductImages(id, dto);
  }

  @Patch(':id/images/reorder')
  reorderImages(
    @Param('id') id: string,
    @Body() dto: ReorderProductImagesDto,
  ) {
    return this.productsService.reorderProductImages(id, dto);
  }

  @Patch(':id/images/:imageId')
  updateImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Body() dto: UpdateProductImageDto,
  ) {
    return this.productsService.updateProductImage(id, imageId, dto);
  }

  @Delete(':id/images/:imageId')
  removeImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ) {
    return this.productsService.removeProductImage(id, imageId);
  }

  /* ═════════════ VARIANTS ═════════════ */
  @Post(':id/variants')
  @HttpCode(HttpStatus.CREATED)
  addVariant(@Param('id') id: string, @Body() dto: AddVariantDto) {
    return this.productsService.addVariant(id, dto);
  }

  @Patch('variants/:variantId')
  updateVariant(
    @Param('variantId') variantId: string,
    @Body() dto: UpdateVariantDto,
  ) {
    return this.productsService.updateVariant(variantId, dto);
  }

  @Patch('variants/:variantId/stock')
  adjustStock(
    @Param('variantId') variantId: string,
    @Body() dto: AdjustStockDto,
  ) {
    return this.productsService.adjustStock(variantId, dto);
  }

  @Delete('variants/:variantId')
  removeVariant(@Param('variantId') variantId: string) {
    return this.productsService.removeVariant(variantId);
  }
}
