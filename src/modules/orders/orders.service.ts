import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  Decimal,
  PrismaClientKnownRequestError,
} from '@prisma/client/runtime/client';
import { Prisma } from 'src/generated/prisma/client';
import type { OrderStatus, ShipmentStatus } from 'src/generated/prisma/enums';
import { OrderWhereInput } from 'src/generated/prisma/models/Order';
import { PricingService } from '../pricings/pricing.service';
import { CartLine } from '../pricings/interfaces/pricing.types';
import { CartIdentity, CartsService } from '../carts/carts.service';
import { generateOrderNumber } from 'src/common/utils/order-number.util';

import { CheckoutDto } from './dto/checkout.dto';
import { MyOrdersQueryDto, OrderQueryDto } from './dto/order-query.dto';
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

/** Valid next statuses for each order status. Empty array = terminal. */
const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED', 'FAILED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['READY_TO_SHIP', 'CANCELLED'],
  READY_TO_SHIP: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: ['COMPLETED', 'REFUNDED'],
  COMPLETED: ['REFUNDED'],
  CANCELLED: [],
  FAILED: [],
  REFUNDED: [],
};

const TERMINAL_SHIPMENT_STATUSES: ShipmentStatus[] = [
  'DELIVERED',
  'CANCELLED',
  'RETURNED',
  'FAILED',
];

const CANCELLABLE_ORDER_STATUSES: OrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'READY_TO_SHIP',
];

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly carts: CartsService,
  ) {}

  // ═════════════════════════════════════════════════
  //   CHECKOUT
  // ═════════════════════════════════════════════════

  async checkout(identity: CartIdentity, dto: CheckoutDto) {
    const cart = await this.carts.getCheckoutCart(identity);

    const lines: CartLine[] = cart.items.map((i) => ({
      variantId: i.variantId,
      quantity: i.quantity,
    }));

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Authoritative pricing — reloads variants fresh inside this
        //    transaction, rejects unpurchasable/insufficient-stock lines.
        const orderPricing = await this.pricing.createOrderPricing(
          lines,
          { currency: cart.currency, userId: identity.userId },
          tx,
        );

        // 2. Atomically commit stock. The pricing check above is a
        //    fast-fail UX nicety; THIS conditional decrement is what
        //    actually prevents overselling under concurrent checkouts.
        for (const line of lines) {
          const result = await tx.productVariant.updateMany({
            where: { id: line.variantId, stock: { gte: line.quantity } },
            data: { stock: { decrement: line.quantity } },
          });
          if (result.count !== 1) {
            const snapshot = orderPricing.snapshots.find(
              (s) => s.variantId === line.variantId,
            );
            throw new BadRequestException(
              `"${snapshot?.productName ?? line.variantId}" no longer has enough stock`,
            );
          }
        }

        const orderNumber = await this.generateUniqueOrderNumber(tx);
        const shippingAddress = dto.shippingAddress;
        const billingAddress = dto.billingAddress ?? dto.shippingAddress;

        const order = await tx.order.create({
          data: {
            orderNumber,
            userId: identity.userId ?? null,
            customerEmail: dto.customerEmail,
            customerName: dto.customerName,
            customerPhone: dto.customerPhone,
            customerNote: dto.customerNote,
            status: 'PENDING',
            currency: cart.currency,
            // Invariant: subtotalAmount - discountAmount + shippingAmount === totalAmount
            subtotalAmount: orderPricing.totals.subtotal,
            discountAmount: orderPricing.totals.itemDiscountTotal.plus(
              orderPricing.totals.orderDiscountTotal,
            ),
            shippingAmount: orderPricing.totals.shippingAmount,
            totalAmount: orderPricing.totals.totalAmount,
            placedAt: new Date(),
          },
        });

        await tx.orderItem.createMany({
          data: orderPricing.snapshots.map((s) => ({
            orderId: order.id,
            productId: s.productId,
            variantId: s.variantId,
            productName: s.productName,
            variantName: s.variantName,
            sku: s.sku,
            quantity: s.quantity,
            unitPrice: s.unitPrice,
            subtotalAmount: s.subtotalAmount,
            discountAmount: s.discountAmount,
            totalAmount: s.totalAmount,
            metadata: s.appliedPromotion
              ? { appliedPromotion: s.appliedPromotion }
              : undefined,
          })),
        });

        if (orderPricing.totals.orderDiscounts.length) {
          await tx.orderDiscount.createMany({
            data: orderPricing.totals.orderDiscounts.map((d) => ({
              orderId: order.id,
              promotionId: d.promotionId,
              promotionName: d.promotionName,
              promotionType: d.promotionType,
              amount: d.discountAmount,
              metadata: d.campaignId ? { campaignId: d.campaignId } : undefined,
            })),
          });
        }

        await tx.orderAddress.createMany({
          data: [
            { orderId: order.id, type: 'SHIPPING', ...shippingAddress },
            { orderId: order.id, type: 'BILLING', ...billingAddress },
          ],
        });

        await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            fromStatus: null,
            toStatus: 'PENDING',
            note: 'Order placed',
            changedByUserId: identity.userId ?? null,
          },
        });

        await tx.payment.create({
          data: {
            orderId: order.id,
            provider: dto.paymentProvider,
            method: dto.paymentMethod,
            status: 'PENDING',
            amount: orderPricing.totals.totalAmount,
            currency: cart.currency,
          },
        });

        await this.carts.convertToOrder(cart.id, order.id, tx);

        // COD needs no online authorization step — confirm immediately.
        if (dto.paymentProvider === 'COD') {
          await this.transitionStatus(
            tx,
            order.id,
            'CONFIRMED',
            'Cash on delivery — auto-confirmed',
            identity.userId ?? null,
          );
        }

        return this.loadOrder(tx, order.id);
      });
    } catch (e) {
      this.handlePrismaError(e, 'Order');
    }
  }

  // ═════════════════════════════════════════════════
  //   LIST / READ
  // ═════════════════════════════════════════════════

  async findAll(query: OrderQueryDto) {
    const {
      page,
      limit,
      search,
      status,
      userId,
      dateFrom,
      dateTo,
      sortBy,
      sortOrder,
    } = query;
    const skip = (page - 1) * limit;

    const where: OrderWhereInput = {
      ...(status && { status }),
      ...(userId && { userId }),
    };

    if (search) {
      where.OR = [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { customerEmail: { contains: search, mode: 'insensitive' } },
        { customerName: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (dateFrom || dateTo) {
      where.createdAt = {
        ...(dateFrom && { gte: dateFrom }),
        ...(dateTo && { lte: dateTo }),
      };
    }

    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: { items: true, payments: true, shipments: true },
      }),
    ]);

    return {
      data: orders,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Orders for one identity. No auth guard exists yet — like CartsService,
   * this trusts the caller-supplied userId until a real auth module lands.
   */
  async findMine(query: MyOrdersQueryDto) {
    const { userId, page, limit, status } = query;
    const skip = (page - 1) * limit;

    const where: OrderWhereInput = { userId, ...(status && { status }) };

    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { items: true, payments: true, shipments: true },
      }),
    ]);

    return {
      data: orders,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async findOne(id: string) {
    return this.loadOrder(this.prisma, id);
  }

  /** Guest order tracking: requires knowing BOTH the order number and the email on it. */
  async lookup(orderNumber: string, email: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNumber },
      include: this.fullOrderInclude(),
    });
    if (!order || order.customerEmail.toLowerCase() !== email.toLowerCase()) {
      throw new NotFoundException('Order not found');
    }
    return { data: order };
  }

  // ═════════════════════════════════════════════════
  //   STATUS
  // ═════════════════════════════════════════════════

  async updateStatus(
    orderId: string,
    dto: UpdateOrderStatusDto,
    actedBy?: string,
  ) {
    await this.prisma.$transaction((tx) =>
      this.transitionStatus(tx, orderId, dto.status, dto.note, actedBy),
    );
    return this.loadOrder(this.prisma, orderId);
  }

  async cancel(orderId: string, dto: CancelOrderDto, actedBy?: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.transitionStatus(
        tx,
        orderId,
        'CANCELLED',
        dto.reason,
        actedBy,
      );

      const items = await tx.orderItem.findMany({
        where: { orderId },
        select: { variantId: true, quantity: true },
      });
      for (const item of items) {
        if (!item.variantId) continue;
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { stock: { increment: item.quantity } },
        });
      }

      const paidPayments = await tx.payment.findMany({
        where: { orderId, status: 'PAID' },
      });
      if (paidPayments.length) {
        const totalPaid = paidPayments.reduce(
          (sum, p) => sum.plus(p.amount),
          new Decimal(0),
        );
        await tx.refundRequest.create({
          data: {
            orderId,
            status: 'PENDING',
            reason: `Order cancelled: ${dto.reason}`,
            amount: totalPaid,
          },
        });
      }
    });

    return this.loadOrder(this.prisma, orderId);
  }

  // ═════════════════════════════════════════════════
  //   ADDRESSES
  // ═════════════════════════════════════════════════

  async updateAddress(
    orderId: string,
    type: 'SHIPPING' | 'BILLING',
    dto: UpdateOrderAddressDto,
  ) {
    const order = await this.getOrderOrThrow(orderId);
    if (!CANCELLABLE_ORDER_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        'Cannot change the address once the order has shipped',
      );
    }

    const address = await this.prisma.orderAddress.findUnique({
      where: { orderId_type: { orderId, type } },
    });
    if (!address) {
      throw new NotFoundException(`${type} address not found for this order`);
    }

    const updated = await this.prisma.orderAddress.update({
      where: { id: address.id },
      data: { ...dto },
    });

    return { message: 'Address updated', data: updated };
  }

  // ═════════════════════════════════════════════════
  //   SHIPMENTS
  // ═════════════════════════════════════════════════

  async createShipment(
    orderId: string,
    dto: CreateShipmentDto,
    actedBy?: string,
  ) {
    const order = await this.getOrderOrThrow(orderId);
    if (!['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'].includes(order.status)) {
      throw new BadRequestException(
        `Cannot create a shipment while order is ${order.status}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.shipment.create({
        data: {
          orderId,
          status: 'PENDING',
          carrier: dto.carrier,
          service: dto.service,
          trackingNumber: dto.trackingNumber,
          trackingUrl: dto.trackingUrl,
          shippingAmount: dto.shippingAmount ?? order.shippingAmount,
          metadata: dto.metadata as Prisma.InputJsonValue | undefined,
        },
      });

      if (order.status !== 'READY_TO_SHIP') {
        await this.transitionStatus(
          tx,
          orderId,
          'READY_TO_SHIP',
          'Shipment created',
          actedBy,
        );
      }
    });

    return this.loadOrder(this.prisma, orderId);
  }

  async updateShipment(
    orderId: string,
    shipmentId: string,
    dto: UpdateShipmentDto,
    actedBy?: string,
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
    });
    if (!shipment || shipment.orderId !== orderId) {
      throw new NotFoundException('Shipment not found for this order');
    }
    if (TERMINAL_SHIPMENT_STATUSES.includes(shipment.status) && dto.status) {
      throw new BadRequestException(
        `Shipment already ${shipment.status} — no further updates allowed`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const extra: Prisma.ShipmentUpdateInput = {};
      if (dto.status === 'SHIPPED') extra.shippedAt = new Date();
      if (dto.status === 'DELIVERED') extra.deliveredAt = new Date();

      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          ...(dto.status && { status: dto.status }),
          ...(dto.carrier !== undefined && { carrier: dto.carrier }),
          ...(dto.service !== undefined && { service: dto.service }),
          ...(dto.trackingNumber !== undefined && {
            trackingNumber: dto.trackingNumber,
          }),
          ...(dto.trackingUrl !== undefined && {
            trackingUrl: dto.trackingUrl,
          }),
          ...(dto.metadata !== undefined && {
            metadata: dto.metadata as Prisma.InputJsonValue,
          }),
          ...extra,
        },
      });

      // Multiple shipments can exist per order (split shipments) — only the
      // FIRST one to reach SHIPPED/DELIVERED should drive the order status.
      const current = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });

      if (dto.status === 'SHIPPED' && current?.status === 'READY_TO_SHIP') {
        await this.transitionStatus(
          tx,
          orderId,
          'SHIPPED',
          'Shipment dispatched',
          actedBy,
        );
      }

      // Only the shipment that actually follows the order's SHIPPED state
      // drives the DELIVERED transition — a later/duplicate "delivered" on
      // another shipment (or one arriving after the order is already
      // DELIVERED/COMPLETED) just updates that shipment record.
      if (dto.status === 'DELIVERED' && current?.status === 'SHIPPED') {
        await this.transitionStatus(
          tx,
          orderId,
          'DELIVERED',
          'Shipment delivered',
          actedBy,
        );
      }

      if (dto.status === 'DELIVERED') {
        // Cash on delivery: money changes hands at the door.
        const codPayment = await tx.payment.findFirst({
          where: { orderId, provider: 'COD', status: 'PENDING' },
        });
        if (codPayment) {
          await tx.payment.update({
            where: { id: codPayment.id },
            data: { status: 'PAID', paidAt: new Date() },
          });
        }
      }
    });

    return this.loadOrder(this.prisma, orderId);
  }

  // ═════════════════════════════════════════════════
  //   PAYMENTS
  // ═════════════════════════════════════════════════

  async createPayment(orderId: string, dto: CreatePaymentDto) {
    const order = await this.getOrderOrThrow(orderId);
    if (['CANCELLED', 'FAILED', 'REFUNDED'].includes(order.status)) {
      throw new BadRequestException(
        `Cannot add a payment to a ${order.status} order`,
      );
    }

    const alreadyPaid = await this.prisma.payment.findFirst({
      where: { orderId, status: 'PAID' },
    });
    if (alreadyPaid) {
      throw new ConflictException('Order is already paid');
    }

    const payment = await this.prisma.payment.create({
      data: {
        orderId,
        provider: dto.provider,
        method: dto.method,
        status: 'PENDING',
        amount: order.totalAmount,
        currency: order.currency,
      },
    });

    return { message: 'Payment attempt created', data: payment };
  }

  async markPaymentPaid(
    orderId: string,
    paymentId: string,
    dto: MarkPaymentPaidDto,
    actedBy?: string,
  ) {
    const payment = await this.ensurePaymentBelongsToOrder(orderId, paymentId);
    if (!['PENDING', 'PROCESSING'].includes(payment.status)) {
      throw new BadRequestException(`Payment already ${payment.status}`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          transactionId: dto.transactionId,
          providerReference: dto.providerReference,
        },
      });

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      if (order?.status === 'PENDING') {
        await this.transitionStatus(
          tx,
          orderId,
          'CONFIRMED',
          'Payment received',
          actedBy,
        );
      }
    });

    return this.loadOrder(this.prisma, orderId);
  }

  async markPaymentFailed(
    orderId: string,
    paymentId: string,
    dto: MarkPaymentFailedDto,
  ) {
    const payment = await this.ensurePaymentBelongsToOrder(orderId, paymentId);
    if (!['PENDING', 'PROCESSING'].includes(payment.status)) {
      throw new BadRequestException(`Payment already ${payment.status}`);
    }

    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'FAILED',
        failureCode: dto.failureCode,
        failureMessage: dto.failureMessage,
      },
    });

    return this.loadOrder(this.prisma, orderId);
  }

  // ═════════════════════════════════════════════════
  //   REFUNDS
  // ═════════════════════════════════════════════════

  async createRefundRequest(orderId: string, dto: CreateRefundRequestDto) {
    const order = await this.getOrderOrThrow(orderId);
    if (!['DELIVERED', 'COMPLETED'].includes(order.status)) {
      throw new BadRequestException(
        `Refunds can only be requested for delivered/completed orders (current: ${order.status})`,
      );
    }

    const existing = await this.prisma.refundRequest.findMany({
      where: { orderId, status: { in: ['PENDING', 'APPROVED', 'PROCESSED'] } },
    });
    const alreadyRequested = existing.reduce(
      (sum, r) => sum.plus(r.amount),
      new Decimal(0),
    );
    const requestedAmount = new Decimal(dto.amount);

    if (alreadyRequested.plus(requestedAmount).gt(order.totalAmount)) {
      const remaining = new Decimal(order.totalAmount).minus(alreadyRequested);
      throw new BadRequestException(
        `Refund amount exceeds order total. Maximum refundable: ${remaining.toFixed(2)}`,
      );
    }

    const refund = await this.prisma.refundRequest.create({
      data: {
        orderId,
        status: 'PENDING',
        reason: dto.reason,
        amount: requestedAmount,
      },
    });

    return { message: 'Refund request submitted', data: refund };
  }

  async reviewRefundRequest(
    refundId: string,
    decision: 'APPROVE' | 'REJECT',
    dto: ReviewRefundRequestDto,
  ) {
    const refund = await this.getRefundOrThrow(refundId);
    if (refund.status !== 'PENDING') {
      throw new BadRequestException(`Refund request already ${refund.status}`);
    }

    const updated = await this.prisma.refundRequest.update({
      where: { id: refundId },
      data: {
        status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        adminNote: dto.adminNote,
        processedBy: dto.processedBy,
      },
    });

    return {
      message: `Refund request ${updated.status.toLowerCase()}`,
      data: updated,
    };
  }

  async processRefundRequest(
    refundId: string,
    dto: ReviewRefundRequestDto,
    actedBy?: string,
  ) {
    const refund = await this.getRefundOrThrow(refundId);
    if (refund.status !== 'APPROVED') {
      throw new BadRequestException(
        'Only approved refund requests can be processed',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.refundRequest.update({
        where: { id: refundId },
        data: {
          status: 'PROCESSED',
          adminNote: dto.adminNote ?? refund.adminNote,
          processedBy: dto.processedBy ?? refund.processedBy,
        },
      });

      const order = await tx.order.findUnique({
        where: { id: refund.orderId },
      });
      if (!order) throw new NotFoundException('Order not found');

      const paidPayment = await tx.payment.findFirst({
        where: { orderId: order.id, status: 'PAID' },
      });
      if (paidPayment) {
        const isFull = new Decimal(refund.amount).gte(paidPayment.amount);
        await tx.payment.update({
          where: { id: paidPayment.id },
          data: { status: isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
        });
      }

      const processedTotal = await tx.refundRequest.aggregate({
        where: { orderId: order.id, status: 'PROCESSED' },
        _sum: { amount: true },
      });
      const totalRefunded = new Decimal(processedTotal._sum.amount ?? 0);

      if (totalRefunded.gte(order.totalAmount) && order.status !== 'REFUNDED') {
        await this.transitionStatus(
          tx,
          order.id,
          'REFUNDED',
          'Fully refunded',
          actedBy,
        );
      }
    });

    return this.loadOrder(this.prisma, refund.orderId);
  }

  // ═════════════════════════════════════════════════
  //   STATUS MACHINE
  // ═════════════════════════════════════════════════

  private async transitionStatus(
    tx: Prisma.TransactionClient,
    orderId: string,
    toStatus: OrderStatus,
    note?: string | null,
    changedByUserId?: string | null,
  ): Promise<OrderStatus> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const allowed = ORDER_STATUS_TRANSITIONS[order.status];
    if (!allowed.includes(toStatus)) {
      throw new BadRequestException(
        `Cannot transition order from ${order.status} to ${toStatus}`,
      );
    }

    const extra: Prisma.OrderUpdateInput = {};
    if (toStatus === 'CANCELLED') extra.cancelledAt = new Date();
    if (toStatus === 'COMPLETED') extra.completedAt = new Date();

    await tx.order.update({
      where: { id: orderId },
      data: { status: toStatus, ...extra },
    });
    await tx.orderStatusHistory.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus,
        note: note ?? undefined,
        changedByUserId: changedByUserId ?? undefined,
      },
    });

    return toStatus;
  }

  // ═════════════════════════════════════════════════
  //   HELPERS
  // ═════════════════════════════════════════════════

  private async generateUniqueOrderNumber(
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateOrderNumber();
      const exists = await tx.order.findUnique({
        where: { orderNumber: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    throw new InternalServerErrorException(
      'Could not generate a unique order number',
    );
  }

  private fullOrderInclude() {
    return {
      items: true,
      addresses: true,
      discounts: true,
      payments: { orderBy: { createdAt: 'asc' as const } },
      shipments: { orderBy: { createdAt: 'asc' as const } },
      statusLogs: { orderBy: { createdAt: 'asc' as const } },
      refundRequests: { orderBy: { createdAt: 'desc' as const } },
    };
  }

  private async loadOrder(
    db: Prisma.TransactionClient | PrismaService,
    orderId: string,
  ) {
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: this.fullOrderInclude(),
    });
    if (!order) throw new NotFoundException('Order not found');
    return { data: order };
  }

  private async getOrderOrThrow(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  private async getRefundOrThrow(refundId: string) {
    const refund = await this.prisma.refundRequest.findUnique({
      where: { id: refundId },
    });
    if (!refund) throw new NotFoundException('Refund request not found');
    return refund;
  }

  private async ensurePaymentBelongsToOrder(
    orderId: string,
    paymentId: string,
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment || payment.orderId !== orderId) {
      throw new NotFoundException('Payment not found for this order');
    }
    return payment;
  }

  private handlePrismaError(error: unknown, entity: string): never {
    if (error instanceof PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new ConflictException(`${entity} already exists`);
      }
      if (error.code === 'P2025') {
        throw new NotFoundException(`${entity} not found`);
      }
      if (error.code === 'P2003') {
        throw new BadRequestException(`${entity} reference constraint failed`);
      }
    }

    if (
      error instanceof NotFoundException ||
      error instanceof ConflictException ||
      error instanceof BadRequestException
    ) {
      throw error;
    }

    throw new InternalServerErrorException(
      `${entity} operation failed unexpectedly`,
    );
  }
}
