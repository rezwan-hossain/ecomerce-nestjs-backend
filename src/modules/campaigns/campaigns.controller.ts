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
import { CampaignsService } from './campaigns.service';

import {
  CreateCampaignDto,
  UpdateCampaignDto,
  CampaignQueryDto,
} from './dto/campaign.dto';
import {
  CreateCampaignBannerDto,
  UpdateCampaignBannerDto,
  ReorderBannersDto,
} from './dto/campaign-banner.dto';
import {
  CreateCampaignSectionDto,
  UpdateCampaignSectionDto,
  AttachSectionProductsDto,
  ReorderSectionsDto,
} from './dto/campaign-section.dto';
import {
  CreateSectionRuleDto,
  UpdateSectionRuleDto,
} from './dto/campaign-section-rule.dto';

@Controller('campaigns')
@UsePipes(ZodValidationPipe)
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  /* ────── CAMPAIGN CRUD ────── */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateCampaignDto) {
    return this.campaignsService.create(dto);
  }

  @Get()
  findAll(@Query() query: CampaignQueryDto) {
    return this.campaignsService.findAll(query);
  }

  @Get('slug/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.campaignsService.findBySlug(slug);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.campaignsService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCampaignDto) {
    return this.campaignsService.update(id, dto);
  }

  @Patch(':id/archive')
  archive(@Param('id') id: string) {
    return this.campaignsService.archive(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.campaignsService.remove(id);
  }

  /* ────── BANNERS ────── */
  @Post(':id/banners')
  @HttpCode(HttpStatus.CREATED)
  createBanner(
    @Param('id') campaignId: string,
    @Body() dto: CreateCampaignBannerDto,
  ) {
    return this.campaignsService.createBanner(campaignId, dto);
  }

  @Get(':id/banners')
  listBanners(@Param('id') campaignId: string) {
    return this.campaignsService.listBanners(campaignId);
  }

  @Patch(':id/banners/reorder')
  reorderBanners(
    @Param('id') campaignId: string,
    @Body() dto: ReorderBannersDto,
  ) {
    return this.campaignsService.reorderBanners(campaignId, dto);
  }

  @Patch('banners/:bannerId')
  updateBanner(
    @Param('bannerId') bannerId: string,
    @Body() dto: UpdateCampaignBannerDto,
  ) {
    return this.campaignsService.updateBanner(bannerId, dto);
  }

  @Delete('banners/:bannerId')
  removeBanner(@Param('bannerId') bannerId: string) {
    return this.campaignsService.removeBanner(bannerId);
  }

  /* ────── SECTIONS ────── */
  @Post(':id/sections')
  @HttpCode(HttpStatus.CREATED)
  createSection(
    @Param('id') campaignId: string,
    @Body() dto: CreateCampaignSectionDto,
  ) {
    return this.campaignsService.createSection(campaignId, dto);
  }

  @Get(':id/sections')
  listSections(@Param('id') campaignId: string) {
    return this.campaignsService.listSections(campaignId);
  }

  @Patch(':id/sections/reorder')
  reorderSections(
    @Param('id') campaignId: string,
    @Body() dto: ReorderSectionsDto,
  ) {
    return this.campaignsService.reorderSections(campaignId, dto);
  }

  @Patch('sections/:sectionId')
  updateSection(
    @Param('sectionId') sectionId: string,
    @Body() dto: UpdateCampaignSectionDto,
  ) {
    return this.campaignsService.updateSection(sectionId, dto);
  }

  @Delete('sections/:sectionId')
  removeSection(@Param('sectionId') sectionId: string) {
    return this.campaignsService.removeSection(sectionId);
  }

  /* ────── SECTION PRODUCTS ────── */
  @Post('sections/:sectionId/products')
  @HttpCode(HttpStatus.CREATED)
  attachProducts(
    @Param('sectionId') sectionId: string,
    @Body() dto: AttachSectionProductsDto,
  ) {
    return this.campaignsService.attachProductsToSection(sectionId, dto);
  }

  @Get('sections/:sectionId/products')
  listSectionProducts(@Param('sectionId') sectionId: string) {
    return this.campaignsService.listSectionProducts(sectionId);
  }

  @Delete('sections/:sectionId/products/:productId')
  detachProduct(
    @Param('sectionId') sectionId: string,
    @Param('productId') productId: string,
  ) {
    return this.campaignsService.detachProductFromSection(sectionId, productId);
  }

  /* ────── SECTION RULES ────── */
  @Post('sections/:sectionId/rules')
  @HttpCode(HttpStatus.CREATED)
  createSectionRule(
    @Param('sectionId') sectionId: string,
    @Body() dto: CreateSectionRuleDto,
  ) {
    return this.campaignsService.createSectionRule(sectionId, dto);
  }

  @Get('sections/:sectionId/rules')
  listSectionRules(@Param('sectionId') sectionId: string) {
    return this.campaignsService.listSectionRules(sectionId);
  }

  @Get('sections/:sectionId/rules/preview')
  previewRuleMatches(@Param('sectionId') sectionId: string) {
    return this.campaignsService.previewRuleMatches(sectionId);
  }

  @Patch('sections/rules/:ruleId')
  updateSectionRule(
    @Param('ruleId') ruleId: string,
    @Body() dto: UpdateSectionRuleDto,
  ) {
    return this.campaignsService.updateSectionRule(ruleId, dto);
  }

  @Delete('sections/rules/:ruleId')
  removeSectionRule(@Param('ruleId') ruleId: string) {
    return this.campaignsService.removeSectionRule(ruleId);
  }
}
