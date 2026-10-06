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
import { InventoryService } from './inventory.service';
import {
  AdjustStockItemDto,
  BulkAdjustStockDto,
  InventoryQueryDto,
  MoveStockDto,
  MovementQueryDto,
  ReceiveStockDto,
  SetDefaultLocationDto,
  StockCountDto,
  UpdateThresholdDto,
} from './dto/inventory.dto';

/**
 * Admin inventory API. Same placeholder as OrdersController: `actedBy` is
 * an optional query param standing in for `@Req().user.id` until an auth
 * module exists, so ledger rows already record who made a change.
 */
@Controller('inventory')
@UsePipes(ZodValidationPipe)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  // ── GET /api/v1/inventory ───────────────────────
  @Get()
  findAll(@Query() query: InventoryQueryDto) {
    return this.inventoryService.findAll(query);
  }

  // ── GET /api/v1/inventory/summary ───────────────
  @Get('summary')
  summary() {
    return this.inventoryService.summary();
  }

  // ── GET /api/v1/inventory/movements ─────────────
  @Get('movements')
  findMovements(@Query() query: MovementQueryDto) {
    return this.inventoryService.findMovements(query);
  }

  // ── GET /api/v1/inventory/variants/:variantId ───
  @Get('variants/:variantId')
  findOne(@Param('variantId') variantId: string) {
    return this.inventoryService.findOne(variantId);
  }

  // ── POST /api/v1/inventory/adjustments ──────────
  @Post('adjustments')
  @HttpCode(HttpStatus.CREATED)
  adjust(@Body() dto: AdjustStockItemDto, @Query('actedBy') actedBy?: string) {
    return this.inventoryService.adjust(dto, actedBy);
  }

  // ── POST /api/v1/inventory/receive ──────────────
  // Goods from a supplier: each item becomes a batch + PURCHASE_RECEIVED.
  @Post('receive')
  @HttpCode(HttpStatus.CREATED)
  receive(@Body() dto: ReceiveStockDto, @Query('actedBy') actedBy?: string) {
    return this.inventoryService.receive(dto, actedBy);
  }

  // ── POST /api/v1/inventory/adjustments/bulk ─────
  @Post('adjustments/bulk')
  @HttpCode(HttpStatus.CREATED)
  bulkAdjust(
    @Body() dto: BulkAdjustStockDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.inventoryService.bulkAdjust(dto, actedBy);
  }

  // ── POST /api/v1/inventory/variants/:variantId/count ──
  @Post('variants/:variantId/count')
  @HttpCode(HttpStatus.OK)
  count(
    @Param('variantId') variantId: string,
    @Body() dto: StockCountDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.inventoryService.count(variantId, dto, actedBy);
  }

  // ── PATCH /api/v1/inventory/variants/:variantId/threshold ──
  @Patch('variants/:variantId/threshold')
  updateThreshold(
    @Param('variantId') variantId: string,
    @Body() dto: UpdateThresholdDto,
  ) {
    return this.inventoryService.updateThreshold(variantId, dto);
  }

  // ── POST /api/v1/inventory/location-moves ───────
  // Rack → rack inside one warehouse; sellable stock is unchanged.
  @Post('location-moves')
  @HttpCode(HttpStatus.CREATED)
  move(@Body() dto: MoveStockDto, @Query('actedBy') actedBy?: string) {
    return this.inventoryService.move(dto, actedBy);
  }

  // ── PATCH /api/v1/inventory/variants/:variantId/default-location ──
  @Patch('variants/:variantId/default-location')
  updateDefaultLocation(
    @Param('variantId') variantId: string,
    @Body() dto: SetDefaultLocationDto,
  ) {
    return this.inventoryService.updateDefaultLocation(variantId, dto);
  }
}
