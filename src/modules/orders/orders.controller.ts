import {
  BadRequestException,
  Body,
  Controller,
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
import { OrdersService } from './orders.service';
import { CheckoutDto } from './dto/checkout.dto';
import {
  MyOrdersQueryDto,
  OrderLookupQueryDto,
  OrderQueryDto,
} from './dto/order-query.dto';
import { CancelOrderDto, UpdateOrderStatusDto } from './dto/order-status.dto';
import { UpdateOrderAddressDto } from './dto/order-address.dto';
import { CreateShipmentDto, UpdateShipmentDto } from './dto/shipment.dto';
import {
  CreatePaymentDto,
  MarkPaymentFailedDto,
  MarkPaymentPaidDto,
} from './dto/payment.dto';
import {
  CreateRefundRequestDto,
  ReviewRefundRequestDto,
} from './dto/refund.dto';
import { CartIdentityQueryDto } from '../carts/dto/cart-identity.dto';

/**
 * Same identity model as CartsController: userId is a query param and
 * a guest is identified by `x-session-id` until a real auth module
 * exists. `actedBy` on admin mutations is likewise a placeholder for
 * `@Req().user.id` — accepted as an optional query param for now so
 * status-history entries have an actor once auth lands.
 */
@Controller('orders')
@UsePipes(ZodValidationPipe)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // ── POST /api/v1/orders/checkout ───────────────
  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  checkout(
    @Query() query: CartIdentityQueryDto,
    @Headers('x-session-id') sessionId: string | undefined,
    @Body() dto: CheckoutDto,
  ) {
    return this.ordersService.checkout(
      { userId: query.userId, sessionId },
      dto,
    );
  }

  // ── GET /api/v1/orders (admin) ─────────────────
  @Get()
  findAll(@Query() query: OrderQueryDto) {
    return this.ordersService.findAll(query);
  }

  // ── GET /api/v1/orders/me ──────────────────────
  @Get('me')
  findMine(@Query() query: MyOrdersQueryDto) {
    return this.ordersService.findMine(query);
  }

  // ── GET /api/v1/orders/lookup (guest tracking) ─
  @Get('lookup')
  lookup(@Query() query: OrderLookupQueryDto) {
    return this.ordersService.lookup(query.orderNumber, query.email);
  }

  // ── GET /api/v1/orders/:id ──────────────────────
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  // ── PATCH /api/v1/orders/:id/status (admin) ────
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.ordersService.updateStatus(id, dto, actedBy);
  }

  // ── PATCH /api/v1/orders/:id/cancel ─────────────
  @Patch(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.ordersService.cancel(id, dto, actedBy);
  }

  // ── PATCH /api/v1/orders/:id/addresses/:type ───
  @Patch(':id/addresses/:type')
  updateAddress(
    @Param('id') id: string,
    @Param('type') type: string,
    @Body() dto: UpdateOrderAddressDto,
  ) {
    if (type !== 'SHIPPING' && type !== 'BILLING') {
      throw new BadRequestException('type must be SHIPPING or BILLING');
    }
    return this.ordersService.updateAddress(id, type, dto);
  }

  // ── SHIPMENTS ────────────────────────────────────
  @Post(':id/shipments')
  @HttpCode(HttpStatus.CREATED)
  createShipment(
    @Param('id') id: string,
    @Body() dto: CreateShipmentDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.ordersService.createShipment(id, dto, actedBy);
  }

  @Patch(':id/shipments/:shipmentId')
  updateShipment(
    @Param('id') id: string,
    @Param('shipmentId') shipmentId: string,
    @Body() dto: UpdateShipmentDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.ordersService.updateShipment(id, shipmentId, dto, actedBy);
  }

  // ── PAYMENTS ─────────────────────────────────────
  @Post(':id/payments')
  @HttpCode(HttpStatus.CREATED)
  createPayment(@Param('id') id: string, @Body() dto: CreatePaymentDto) {
    return this.ordersService.createPayment(id, dto);
  }

  @Patch(':id/payments/:paymentId/paid')
  markPaymentPaid(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() dto: MarkPaymentPaidDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.ordersService.markPaymentPaid(id, paymentId, dto, actedBy);
  }

  @Patch(':id/payments/:paymentId/failed')
  markPaymentFailed(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() dto: MarkPaymentFailedDto,
  ) {
    return this.ordersService.markPaymentFailed(id, paymentId, dto);
  }

  // ── REFUNDS ──────────────────────────────────────
  @Post(':id/refund-requests')
  @HttpCode(HttpStatus.CREATED)
  createRefundRequest(
    @Param('id') id: string,
    @Body() dto: CreateRefundRequestDto,
  ) {
    return this.ordersService.createRefundRequest(id, dto);
  }

  @Patch('refund-requests/:refundId/approve')
  approveRefund(
    @Param('refundId') refundId: string,
    @Body() dto: ReviewRefundRequestDto,
  ) {
    return this.ordersService.reviewRefundRequest(refundId, 'APPROVE', dto);
  }

  @Patch('refund-requests/:refundId/reject')
  rejectRefund(
    @Param('refundId') refundId: string,
    @Body() dto: ReviewRefundRequestDto,
  ) {
    return this.ordersService.reviewRefundRequest(refundId, 'REJECT', dto);
  }

  @Patch('refund-requests/:refundId/process')
  processRefund(
    @Param('refundId') refundId: string,
    @Body() dto: ReviewRefundRequestDto,
    @Query('actedBy') actedBy?: string,
  ) {
    return this.ordersService.processRefundRequest(refundId, dto, actedBy);
  }
}
