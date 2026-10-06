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
import { StorageLocationsService } from './storage-locations.service';
import {
  CreateLocationDto,
  LocationQueryDto,
  UpdateLocationDto,
} from './dto/storage-location.dto';

/** Admin API for racks / shelves / bins inside a warehouse. */
@Controller('inventory/locations')
@UsePipes(ZodValidationPipe)
export class StorageLocationsController {
  constructor(private readonly locationsService: StorageLocationsService) {}

  // ── GET /api/v1/inventory/locations ─────────────
  @Get()
  findAll(@Query() query: LocationQueryDto) {
    return this.locationsService.findAll(query);
  }

  // ── GET /api/v1/inventory/locations/:id ─────────
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.locationsService.findOne(id);
  }

  // ── POST /api/v1/inventory/locations ────────────
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateLocationDto) {
    return this.locationsService.create(dto);
  }

  // ── PATCH /api/v1/inventory/locations/:id ───────
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.locationsService.update(id, dto);
  }

  // ── DELETE /api/v1/inventory/locations/:id ──────
  // Removes the location and its subtree, or deactivates it if it has
  // history: { result: 'deleted' | 'deactivated' }.
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.locationsService.remove(id);
  }
}
