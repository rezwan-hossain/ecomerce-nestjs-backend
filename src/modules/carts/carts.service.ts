import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { Prisma } from 'src/generated/prisma/client';
import { PricingService } from '../pricings/pricing.service';
import {
  VARIANT_PRICING_INCLUDE,
  isVariantPurchasable,
  toVariantPricingData,
} from '../pricings/variant-pricing.mapper';
import { VariantPricingData } from '../pricings/interfaces/pricing.types';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart-item.dto';

export interface CartIdentity {
  userId?: string;
  sessionId?: string;
}

const CART_EXPIRY_DAYS = 30;

@Injectable()
export class CartsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
  ) {}

  // ═════════════════════════════════════════════════
  //   PUBLIC API
  // ═════════════════════════════════════════════════

  /** Resolve (or lazily create) the identity's active cart, with live pricing. */
  async getOrCreateCart(identity: CartIdentity) {
    const cart = await this.findOrCreateActiveCart(identity);
    return this.buildCartResponse(cart.id);
  }

  async addItem(identity: CartIdentity, dto: AddCartItemDto) {
    const variant = await this.loadVariant(dto.variantId);
    if (!isVariantPurchasable(variant)) {
      throw new BadRequestException(
        `"${variant.product.name}" is not available for purchase`,
      );
    }

    const cart = await this.findOrCreateActiveCart(identity);

    try {
      await this.prisma.$transaction(async (tx) => {
        const item = await tx.cartItem.upsert({
          where: {
            cartId_variantId: { cartId: cart.id, variantId: dto.variantId },
          },
          create: {
            cartId: cart.id,
            variantId: dto.variantId,
            quantity: dto.quantity,
          },
          update: {
            quantity: { increment: dto.quantity },
          },
        });

        if (item.quantity > variant.stock) {
          throw new BadRequestException(
            `Only ${variant.stock} unit(s) of "${variant.product.name}" (${variant.name}) available`,
          );
        }

        await this.touchExpiry(tx, cart.id);
      });
    } catch (e) {
      this.handlePrismaError(e, 'Cart item');
    }

    return this.buildCartResponse(cart.id);
  }

  async updateItemQuantity(
    identity: CartIdentity,
    itemId: string,
    dto: UpdateCartItemDto,
  ) {
    const cart = await this.requireActiveCart(identity);
    const item = await this.ensureItemBelongsToCart(cart.id, itemId);

    const variant = await this.loadVariant(item.variantId);
    if (!isVariantPurchasable(variant)) {
      throw new BadRequestException(
        `"${variant.product.name}" is no longer available — remove it from the cart instead`,
      );
    }
    if (dto.quantity > variant.stock) {
      throw new BadRequestException(
        `Only ${variant.stock} unit(s) of "${variant.product.name}" (${variant.name}) available`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.cartItem.update({
        where: { id: itemId },
        data: { quantity: dto.quantity },
      });
      await this.touchExpiry(tx, cart.id);
    });

    return this.buildCartResponse(cart.id);
  }

  async removeItem(identity: CartIdentity, itemId: string) {
    const cart = await this.requireActiveCart(identity);
    await this.ensureItemBelongsToCart(cart.id, itemId);

    await this.prisma.cartItem.delete({ where: { id: itemId } });

    return this.buildCartResponse(cart.id);
  }

  async clearCart(identity: CartIdentity) {
    const cart = await this.findActiveCart(identity);
    if (!cart) {
      return { message: 'Cart is already empty', data: null };
    }

    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });

    return this.buildCartResponse(cart.id);
  }

  /**
   * Merge a guest cart (identified by sessionId) into the authenticated
   * user's cart. Called once, right after login. Idempotent: if there's
   * no guest cart (or it's already claimed / empty), it just returns the
   * user's cart untouched.
   */
  async mergeGuestCartIntoUser(userId: string, sessionId?: string) {
    if (!sessionId) {
      return this.getOrCreateCart({ userId });
    }

    const guestCart = await this.prisma.cart.findFirst({
      where: { sessionId, userId: null, status: 'ACTIVE' },
      include: { items: true },
    });

    if (!guestCart || guestCart.items.length === 0) {
      return this.getOrCreateCart({ userId });
    }

    const userCart = await this.findActiveCart({ userId });

    if (!userCart) {
      // No existing user cart — the guest cart simply becomes the user's cart.
      await this.prisma.cart.update({
        where: { id: guestCart.id },
        data: { userId, expiresAt: this.nextExpiry() },
      });
      return this.buildCartResponse(guestCart.id);
    }

    const warnings: string[] = [];

    await this.prisma.$transaction(async (tx) => {
      for (const guestItem of guestCart.items) {
        const variant = await this.loadVariant(guestItem.variantId, tx);

        if (!isVariantPurchasable(variant)) {
          warnings.push(
            `"${variant.product.name}" was removed — no longer available`,
          );
          continue;
        }

        const existing = await tx.cartItem.findUnique({
          where: {
            cartId_variantId: { cartId: userCart.id, variantId: variant.id },
          },
        });

        const requested = (existing?.quantity ?? 0) + guestItem.quantity;
        const finalQty = Math.min(requested, variant.stock);

        if (finalQty <= 0) {
          warnings.push(
            `"${variant.product.name}" (${variant.name}) is out of stock — not merged`,
          );
          continue;
        }
        if (finalQty < requested) {
          warnings.push(
            `"${variant.product.name}" (${variant.name}) capped at ${finalQty} available unit(s)`,
          );
        }

        await tx.cartItem.upsert({
          where: {
            cartId_variantId: { cartId: userCart.id, variantId: variant.id },
          },
          create: {
            cartId: userCart.id,
            variantId: variant.id,
            quantity: finalQty,
          },
          update: { quantity: finalQty },
        });
      }

      await this.touchExpiry(tx, userCart.id);
      await tx.cart.delete({ where: { id: guestCart.id } });
    });

    const response = await this.buildCartResponse(userCart.id);
    return { ...response, warnings };
  }

  // ═════════════════════════════════════════════════
  //   INTERNAL API (for other modules — no HTTP route)
  // ═════════════════════════════════════════════════

  /**
   * The identity's active cart with its items, for checkout. Unlike
   * getOrCreateCart, this never creates a cart — an empty/missing cart
   * at checkout time is a real error, not something to paper over.
   */
  async getCheckoutCart(identity: CartIdentity) {
    const cart = await this.findActiveCart(identity);
    if (!cart) throw new NotFoundException('No active cart found');

    const items = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
    });
    if (items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    return { ...cart, items };
  }

  /** Raw lookup by cart id. No ownership check — callers must be trusted internal code. */
  async findById(cartId: string) {
    const cart = await this.prisma.cart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException(`Cart "${cartId}" not found`);
    return cart;
  }

  /** Marks a cart as converted once an order has been placed from it. */
  async convertToOrder(
    cartId: string,
    orderId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    await db.cart.update({
      where: { id: cartId },
      data: { status: 'CONVERTED', convertedOrderId: orderId },
    });
  }

  // ═════════════════════════════════════════════════
  //   CART RESOLUTION
  // ═════════════════════════════════════════════════

  private async findActiveCart(identity: CartIdentity) {
    this.assertIdentity(identity);

    const cart = await this.prisma.cart.findFirst({
      where: identity.userId
        ? { userId: identity.userId, status: 'ACTIVE' }
        : { sessionId: identity.sessionId, userId: null, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    if (!cart) return null;

    if (cart.expiresAt && cart.expiresAt < new Date()) {
      await this.prisma.cart.update({
        where: { id: cart.id },
        data: { status: 'EXPIRED' },
      });
      return null;
    }

    return cart;
  }

  private async findOrCreateActiveCart(identity: CartIdentity) {
    const existing = await this.findActiveCart(identity);
    if (existing) return existing;

    return this.prisma.cart.create({
      data: {
        userId: identity.userId,
        sessionId: identity.userId ? undefined : identity.sessionId,
        status: 'ACTIVE',
        expiresAt: this.nextExpiry(),
      },
    });
  }

  private async requireActiveCart(identity: CartIdentity) {
    const cart = await this.findActiveCart(identity);
    if (!cart) throw new NotFoundException('Cart not found');
    return cart;
  }

  private assertIdentity(identity: CartIdentity) {
    if (!identity.userId && !identity.sessionId) {
      throw new BadRequestException(
        'A userId or x-session-id header is required to resolve a cart',
      );
    }
  }

  private async ensureItemBelongsToCart(cartId: string, itemId: string) {
    const item = await this.prisma.cartItem.findUnique({
      where: { id: itemId },
    });
    if (!item || item.cartId !== cartId) {
      throw new NotFoundException('Cart item not found');
    }
    return item;
  }

  private nextExpiry(): Date {
    return new Date(Date.now() + CART_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  }

  private async touchExpiry(tx: Prisma.TransactionClient, cartId: string) {
    await tx.cart.update({
      where: { id: cartId },
      data: { expiresAt: this.nextExpiry() },
    });
  }

  // ═════════════════════════════════════════════════
  //   PRICING / RESPONSE ASSEMBLY
  // ═════════════════════════════════════════════════

  private async loadVariant(
    variantId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<VariantPricingData> {
    const variant = await db.productVariant.findUnique({
      where: { id: variantId },
      include: VARIANT_PRICING_INCLUDE,
    });
    if (!variant) {
      throw new NotFoundException(`Variant "${variantId}" not found`);
    }
    return toVariantPricingData(variant);
  }

  private async buildCartResponse(cartId: string) {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      include: {
        items: { include: { variant: { include: VARIANT_PRICING_INCLUDE } } },
      },
    });
    if (!cart) throw new NotFoundException('Cart not found');

    if (cart.items.length === 0) {
      const empty = await this.pricing.calculateCartPrices([], {
        currency: cart.currency,
      });
      return {
        data: {
          id: cart.id,
          status: cart.status,
          currency: cart.currency,
          expiresAt: cart.expiresAt,
          items: [],
          itemCount: 0,
          hasUnavailableItems: false,
          pricing: empty,
        },
      };
    }

    const variantsByItemId = new Map(
      cart.items.map((ci) => [ci.id, toVariantPricingData(ci.variant)]),
    );

    const priced = await this.pricing.calculateCartPrices(
      cart.items.map((ci) => ({
        quantity: ci.quantity,
        variant: variantsByItemId.get(ci.id)!,
      })),
      { currency: cart.currency },
    );

    const priceByVariantId = new Map(priced.items.map((r) => [r.variantId, r]));

    const items = cart.items.map((ci) => {
      const variant = variantsByItemId.get(ci.id)!;
      const price = priceByVariantId.get(ci.variantId)!;
      const available = isVariantPurchasable(variant) && variant.stock > 0;

      return {
        id: ci.id,
        variantId: ci.variantId,
        sku: variant.sku,
        name: variant.name,
        quantity: ci.quantity,
        unitPrice: price.originalUnitPrice,
        subtotalAmount: price.originalLineTotal,
        discountAmount: price.discountAmount,
        totalAmount: price.effectiveLineTotal,
        effectiveUnitPrice: price.effectiveUnitPrice,
        appliedPromotion: price.appliedDiscount,
        isAvailable: available,
        availableStock: variant.stock,
        isBelowRequestedQuantity: variant.stock < ci.quantity,
      };
    });

    return {
      data: {
        id: cart.id,
        status: cart.status,
        currency: cart.currency,
        expiresAt: cart.expiresAt,
        items,
        itemCount: items.reduce((n, i) => n + i.quantity, 0),
        hasUnavailableItems: items.some(
          (i) => !i.isAvailable || i.isBelowRequestedQuantity,
        ),
        pricing: priced,
      },
    };
  }

  // ═════════════════════════════════════════════════
  //   HELPERS
  // ═════════════════════════════════════════════════

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
