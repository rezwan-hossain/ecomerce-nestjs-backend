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
import { TagsService } from './tags.service';
import { CreateTagDto, UpdateTagDto, TagQueryDto } from './dto/tag.dto';

@Controller('tags')
@UsePipes(ZodValidationPipe)
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  // ── POST /api/v1/tags (ADMIN+) ─────────────────
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateTagDto) {
    return this.tagsService.create(dto);
  }

  // ── GET /api/v1/tags (Public) ──────────────────
  @Get()
  findAll(@Query() query: TagQueryDto) {
    return this.tagsService.findAll(query);
  }

  // ── GET /api/v1/tags/:id (Public) ──────────────
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.tagsService.findOne(id);
  }

  // ── PATCH /api/v1/tags/:id (ADMIN+) ────────────
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTagDto) {
    return this.tagsService.update(id, dto);
  }

  // ── DELETE /api/v1/tags/:id (ADMIN+) ───────────
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.tagsService.remove(id);
  }
}
