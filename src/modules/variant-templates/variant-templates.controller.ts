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
import { VariantTemplatesService } from './variant-templates.service';
import {
  CreateVariantTemplateDto,
  UpdateVariantTemplateDto,
  VariantTemplateQueryDto,
} from './dto/variant-template.dto';

@Controller('variant-templates')
@UsePipes(ZodValidationPipe)
export class VariantTemplatesController {
  constructor(
    private readonly variantTemplatesService: VariantTemplatesService,
  ) {}

  // ── POST /api/v1/variant-templates (ADMIN+) ────
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateVariantTemplateDto) {
    return this.variantTemplatesService.create(dto);
  }

  // ── GET /api/v1/variant-templates (Public) ─────
  @Get()
  findAll(@Query() query: VariantTemplateQueryDto) {
    return this.variantTemplatesService.findAll(query);
  }

  // ── GET /api/v1/variant-templates/:id (Public) ─
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.variantTemplatesService.findOne(id);
  }

  // ── PATCH /api/v1/variant-templates/:id (ADMIN+)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateVariantTemplateDto) {
    return this.variantTemplatesService.update(id, dto);
  }

  // ── DELETE /api/v1/variant-templates/:id (ADMIN+)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.variantTemplatesService.remove(id);
  }
}
