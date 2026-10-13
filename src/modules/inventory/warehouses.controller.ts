import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { WarehousesService } from './warehouses.service';
import {
  CreateWarehouseDto,
  UpdateWarehouseDto,
  WarehouseStockQueryDto,
} from './dto/warehouse.dto';

/** Warehouses (ADMIN+). No auth module yet; see docs/api/inventory-workflows.md. */
@Controller('inventory/warehouses')
@UsePipes(ZodValidationPipe)
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  // ── GET /inventory/warehouses (ADMIN+) ──────────
  @Get()
  findAll() {
    return this.warehouses.findAll();
  }

  // ── POST /inventory/warehouses (ADMIN+) ─────────
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateWarehouseDto) {
    return this.warehouses.create(dto);
  }

  // ── GET /inventory/warehouses/:id (ADMIN+) ──────
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.warehouses.findOne(id);
  }

  // ── GET /inventory/warehouses/:id/stock (ADMIN+) ──
  @Get(':id/stock')
  stock(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: WarehouseStockQueryDto,
  ) {
    return this.warehouses.stock(id, query);
  }

  // ── PATCH /inventory/warehouses/:id (ADMIN+) ────
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    return this.warehouses.update(id, dto);
  }

  // ── DELETE /inventory/warehouses/:id (ADMIN+) ───
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.warehouses.remove(id);
  }
}
