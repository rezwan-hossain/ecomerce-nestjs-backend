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
import { OptionsService } from './options.service';
import {
  CreateOptionDto,
  UpdateOptionDto,
  OptionQueryDto,
} from './dto/option.dto';
import {
  CreateOptionValueDto,
  UpdateOptionValueDto,
} from './dto/option-value.dto';

@Controller('options')
@UsePipes(ZodValidationPipe)
export class OptionsController {
  constructor(private readonly optionsService: OptionsService) {}

  // ── POST /api/v1/options (ADMIN+) ──────────────
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateOptionDto) {
    return this.optionsService.create(dto);
  }

  // ── GET /api/v1/options (Public) ───────────────
  @Get()
  findAll(@Query() query: OptionQueryDto) {
    return this.optionsService.findAll(query);
  }

  // ── GET /api/v1/options/:id (Public) ───────────
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.optionsService.findOne(id);
  }

  // ── PATCH /api/v1/options/:id (ADMIN+) ─────────
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateOptionDto) {
    return this.optionsService.update(id, dto);
  }

  // ── DELETE /api/v1/options/:id (ADMIN+) ────────
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.optionsService.remove(id);
  }

  // ── POST /api/v1/options/:optionId/values (ADMIN+) ──
  @Post(':optionId/values')
  @HttpCode(HttpStatus.CREATED)
  addValue(
    @Param('optionId') optionId: string,
    @Body() dto: CreateOptionValueDto,
  ) {
    return this.optionsService.addValue(optionId, dto);
  }

  // ── PATCH /api/v1/options/:optionId/values/:valueId (ADMIN+) ──
  @Patch(':optionId/values/:valueId')
  updateValue(
    @Param('optionId') optionId: string,
    @Param('valueId') valueId: string,
    @Body() dto: UpdateOptionValueDto,
  ) {
    return this.optionsService.updateValue(optionId, valueId, dto);
  }

  // ── DELETE /api/v1/options/:optionId/values/:valueId (ADMIN+) ──
  @Delete(':optionId/values/:valueId')
  @HttpCode(HttpStatus.OK)
  removeValue(
    @Param('optionId') optionId: string,
    @Param('valueId') valueId: string,
  ) {
    return this.optionsService.removeValue(optionId, valueId);
  }
}
