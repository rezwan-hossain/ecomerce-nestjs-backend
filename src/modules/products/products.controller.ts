import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Get,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto, ProductQueryDto } from './dto/product.dto';

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
}
