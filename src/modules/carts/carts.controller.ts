import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { CartsService } from './carts.service';
import {
  CartIdentityQueryDto,
  MergeCartQueryDto,
} from './dto/cart-identity.dto';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart-item.dto';

/**
 * Cart resolution has no auth guard yet: `userId` is read from the query
 * string and a guest is identified by a client-generated `x-session-id`
 * header. Once a real auth module exists, replace `query.userId` with
 * `@Req().user.id` here — CartsService already takes an identity object,
 * so nothing below the controller needs to change.
 */
@Controller('carts')
@UsePipes(ZodValidationPipe)
export class CartsController {
  constructor(private readonly cartsService: CartsService) {}

  // ── GET /api/v1/carts/me ───────────────────────
  @Get('me')
  getCart(
    @Query() query: CartIdentityQueryDto,
    @Headers('x-session-id') sessionId?: string,
  ) {
    return this.cartsService.getOrCreateCart({
      userId: query.userId,
      sessionId,
    });
  }

  // ── POST /api/v1/carts/me/items ────────────────
  @Post('me/items')
  @HttpCode(HttpStatus.CREATED)
  addItem(
    @Query() query: CartIdentityQueryDto,
    @Headers('x-session-id') sessionId: string | undefined,
    @Body() dto: AddCartItemDto,
  ) {
    return this.cartsService.addItem({ userId: query.userId, sessionId }, dto);
  }

  // ── PATCH /api/v1/carts/me/items/:itemId ───────
  @Patch('me/items/:itemId')
  updateItem(
    @Query() query: CartIdentityQueryDto,
    @Headers('x-session-id') sessionId: string | undefined,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateCartItemDto,
  ) {
    return this.cartsService.updateItemQuantity(
      { userId: query.userId, sessionId },
      itemId,
      dto,
    );
  }

  // ── DELETE /api/v1/carts/me/items/:itemId ──────
  @Delete('me/items/:itemId')
  @HttpCode(HttpStatus.OK)
  removeItem(
    @Query() query: CartIdentityQueryDto,
    @Headers('x-session-id') sessionId: string | undefined,
    @Param('itemId') itemId: string,
  ) {
    return this.cartsService.removeItem(
      { userId: query.userId, sessionId },
      itemId,
    );
  }

  // ── DELETE /api/v1/carts/me ─────────────────────
  @Delete('me')
  @HttpCode(HttpStatus.OK)
  clearCart(
    @Query() query: CartIdentityQueryDto,
    @Headers('x-session-id') sessionId?: string,
  ) {
    return this.cartsService.clearCart({ userId: query.userId, sessionId });
  }

  // ── POST /api/v1/carts/merge (post-login) ──────
  @Post('merge')
  mergeCart(
    @Query() query: MergeCartQueryDto,
    @Headers('x-session-id') sessionId?: string,
  ) {
    return this.cartsService.mergeGuestCartIntoUser(query.userId, sessionId);
  }
}
