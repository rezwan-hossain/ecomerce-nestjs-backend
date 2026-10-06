import {
  Body,
  Controller,
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
import { SuppliersService } from './suppliers.service';
import {
  CreateSupplierDto,
  SupplierQueryDto,
  UpdateSupplierDto,
} from './dto/supplier.dto';

/**
 * No DELETE: batches and purchase orders keep pointing at a supplier for
 * traceability, so retire one with PATCH { isActive: false } instead.
 */
@Controller('suppliers')
@UsePipes(ZodValidationPipe)
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  // POST /suppliers
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateSupplierDto) {
    return this.suppliersService.create(dto);
  }

  // GET /suppliers?search=&isActive=&page=&limit=
  @Get()
  findAll(@Query() query: SupplierQueryDto) {
    return this.suppliersService.findAll(query);
  }

  // GET /suppliers/:id
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.suppliersService.findOne(id);
  }

  // PATCH /suppliers/:id
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliersService.update(id, dto);
  }
}
