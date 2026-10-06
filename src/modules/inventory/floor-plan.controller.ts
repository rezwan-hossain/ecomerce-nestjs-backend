import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { FloorPlanService } from './floor-plan/floor-plan.service';
import { InventoryService } from './inventory.service';
import {
  CreateRackDto,
  FloorPlanQueryDto,
  FloorSizeDto,
  PickRouteQueryDto,
  PlacementBodyDto,
  RotateDto,
} from './dto/floor-plan.dto';
import { LocationCountDto, LocationMoveDto } from './dto/inventory.dto';

/**
 * Rack map API. No auth module exists yet, so like the rest of inventory
 * `actedBy` (query) stands in for the signed-in user on stock writes; see
 * docs/api/rack-map.md for the intended role rules.
 */
@Controller('inventory')
@UsePipes(ZodValidationPipe)
export class FloorPlanController {
  constructor(
    private readonly floorPlan: FloorPlanService,
    private readonly inventory: InventoryService,
  ) {}

  // ── Warehouse ───────────────────────────────────

  @Get('warehouses/:warehouseId/floor-plan')
  getFloorPlan(
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Query() query: FloorPlanQueryDto,
  ) {
    return this.floorPlan.floorPlan(warehouseId, query.activityDays);
  }

  @Put('warehouses/:warehouseId/floor-size')
  setFloorSize(
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Body() dto: FloorSizeDto,
  ) {
    return this.floorPlan.setFloorSize(warehouseId, dto);
  }

  @Get('warehouses/:warehouseId/put-away')
  putAway(@Param('warehouseId', ParseUUIDPipe) warehouseId: string) {
    return this.floorPlan.putAway(warehouseId);
  }

  @Get('warehouses/:warehouseId/pick-route')
  pickRoute(
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Query() query: PickRouteQueryDto,
  ) {
    return this.floorPlan.pickRoute(warehouseId, query.orderId);
  }

  @Post('warehouses/:warehouseId/racks')
  @HttpCode(HttpStatus.CREATED)
  createRack(
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Body() dto: CreateRackDto,
  ) {
    return this.floorPlan.createRack(warehouseId, dto);
  }

  // ── Locations ───────────────────────────────────
  // (PATCH / DELETE /inventory/locations/:id live in StorageLocationsController)

  @Get('locations/:locationId/contents')
  contents(@Param('locationId', ParseUUIDPipe) locationId: string) {
    return this.floorPlan.contents(locationId);
  }

  @Patch('locations/:locationId/placement')
  setPlacement(
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Body() body: PlacementBodyDto,
  ) {
    return this.floorPlan.setPlacement(locationId, body);
  }

  @Post('locations/:locationId/rotate')
  @HttpCode(HttpStatus.OK)
  rotate(
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Body() dto: RotateDto,
  ) {
    return this.floorPlan.rotate(locationId, dto.direction);
  }

  @Post('locations/:fromLocationId/moves')
  @HttpCode(HttpStatus.CREATED)
  move(
    @Param('fromLocationId', ParseUUIDPipe) fromLocationId: string,
    @Body() dto: LocationMoveDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.inventory.moveFromLocation(fromLocationId, dto, actedBy);
  }

  @Post('locations/:locationId/counts')
  @HttpCode(HttpStatus.CREATED)
  count(
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Body() dto: LocationCountDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.inventory.countLocation(locationId, dto, actedBy);
  }
}
