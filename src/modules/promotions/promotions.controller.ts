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
import { PromotionsService } from './promotions.service';

import {
  CreatePromotionDto,
  UpdatePromotionDto,
  PromotionQueryDto,
} from './dto/promotion.dto';
import { AttachTargetsDto } from './dto/promotion-target.dto';
import { AttachCampaignsDto } from './dto/promotion-campaign.dto';

@Controller('promotions')
@UsePipes(ZodValidationPipe)
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  /* ═════════════ PROMOTION CRUD ═════════════ */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreatePromotionDto) {
    return this.promotionsService.create(dto);
  }

  @Get()
  findAll(@Query() query: PromotionQueryDto) {
    return this.promotionsService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.promotionsService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePromotionDto) {
    return this.promotionsService.update(id, dto);
  }

  @Patch(':id/archive')
  archive(@Param('id') id: string) {
    return this.promotionsService.archive(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.promotionsService.remove(id);
  }

  /* ═════════════ TARGETS ═════════════ */
  @Post(':id/targets')
  @HttpCode(HttpStatus.CREATED)
  attachTargets(@Param('id') id: string, @Body() dto: AttachTargetsDto) {
    return this.promotionsService.attachTargets(id, dto);
  }

  @Get(':id/targets')
  listTargets(@Param('id') id: string) {
    return this.promotionsService.listTargets(id);
  }

  @Delete('targets/:targetId')
  detachTarget(@Param('targetId') targetId: string) {
    return this.promotionsService.detachTarget(targetId);
  }

  /* ═════════════ CAMPAIGNS ═════════════ */
  @Post(':id/campaigns')
  @HttpCode(HttpStatus.CREATED)
  attachCampaigns(@Param('id') id: string, @Body() dto: AttachCampaignsDto) {
    return this.promotionsService.attachCampaigns(id, dto);
  }

  @Get(':id/campaigns')
  listCampaigns(@Param('id') id: string) {
    return this.promotionsService.listCampaigns(id);
  }

  @Delete(':id/campaigns/:campaignId')
  detachCampaign(
    @Param('id') id: string,
    @Param('campaignId') campaignId: string,
  ) {
    return this.promotionsService.detachCampaign(id, campaignId);
  }
}
