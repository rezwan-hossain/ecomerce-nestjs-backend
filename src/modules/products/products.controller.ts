import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/product.dto';

@Controller('products')
export class ProductsController {
  constructor(private productService: ProductsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: CreateProductDto) {
    return this.productService.createProduct(body);
  }
}
