import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Get,
  Param,
  Delete,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import {
  AddProductImagesDto,
  CreateProductDto,
  ProductQueryDto,
} from './dto/product.dto';

@Controller('products')
export class ProductsController {
  constructor(private productService: ProductsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: CreateProductDto) {
    return this.productService.createProduct(body);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  findAll(@Query() query: ProductQueryDto) {
    return this.productService.findAll(query);
  }

  @Get(':id')
  findOneById(@Param('id') id: string) {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      );

    return isUuid
      ? this.productService.findOneById(id)
      : this.productService.findOneBySlug(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.productService.removeProduct(id);
  }

  // ── Images ─────────────────────
  @Post(':id/images')
  @HttpCode(HttpStatus.OK)
  addImages(@Param('id') id: string, @Body() body: AddProductImagesDto) {
    return this.productService.addProductImages(id, body);
  }
}
