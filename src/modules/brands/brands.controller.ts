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
import { BrandsService } from './brands.service';
import { CreateBrandDto, UpdateBrandDto, BrandQueryDto } from './dto/brand.dto';

@Controller('brands')
@UsePipes(ZodValidationPipe) // Enforces nestjs-zod validation automatically
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  // POST /api/v1/brands (ADMIN+)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateBrandDto) {
    return this.brandsService.create(dto);
  }

  // GET /api/v1/brands (Public with Query Params)
  @Get()
  findAll(@Query() query: BrandQueryDto) {
    return this.brandsService.findAll(query);
  }

  // GET /api/v1/brands/slug/:slug (Public)
  // ⚠️ Declared BEFORE ':id' so NestJS parses this route correctly
  @Get('slug/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.brandsService.findBySlug(slug);
  }

  // GET /api/v1/brands/:id (Public)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.brandsService.findOne(id);
  }

  // PATCH /api/v1/brands/:id (ADMIN+)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateBrandDto) {
    return this.brandsService.update(id, dto);
  }

  // DELETE /api/v1/brands/:id (ADMIN+)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.brandsService.remove(id);
  }
}
