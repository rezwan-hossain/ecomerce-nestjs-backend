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
import { ReviewsService } from './reviews.service';
import {
  CreateReviewDto,
  UpdateReviewDto,
  ModerateReviewDto,
  ReviewQueryDto,
  ProductReviewQueryDto,
  ReviewerQueryDto,
} from './dto/review.dto';

/**
 * No auth guard yet: the reviewer's `userId` is a query param (same
 * placeholder as CartsController). Replace `query.userId` with
 * `@Req().user.id` once an auth module exists.
 */
@Controller('reviews')
@UsePipes(ZodValidationPipe)
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  // ── POST /api/v1/reviews (Customer) ────────────
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Query() query: ReviewerQueryDto, @Body() dto: CreateReviewDto) {
    return this.reviewsService.create(query.userId, dto);
  }

  // ── GET /api/v1/reviews (ADMIN+) ───────────────
  @Get()
  findAll(@Query() query: ReviewQueryDto) {
    return this.reviewsService.findAll(query);
  }

  // ── GET /api/v1/reviews/products/:productId (Public) ──
  @Get('products/:productId')
  findForProduct(
    @Param('productId') productId: string,
    @Query() query: ProductReviewQueryDto,
  ) {
    return this.reviewsService.findForProduct(productId, query);
  }

  // ── GET /api/v1/reviews/:id ────────────────────
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.reviewsService.findOne(id);
  }

  // ── PATCH /api/v1/reviews/:id (Author) ─────────
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Query() query: ReviewerQueryDto,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.reviewsService.update(id, query.userId, dto);
  }

  // ── PATCH /api/v1/reviews/:id/status (ADMIN+) ──
  @Patch(':id/status')
  moderate(@Param('id') id: string, @Body() dto: ModerateReviewDto) {
    return this.reviewsService.moderate(id, dto);
  }

  // ── DELETE /api/v1/reviews/:id (Author) ────────
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string, @Query() query: ReviewerQueryDto) {
    return this.reviewsService.remove(id, query.userId);
  }
}
