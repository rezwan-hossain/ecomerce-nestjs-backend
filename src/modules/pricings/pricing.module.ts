// src/modules/pricing/pricing.module.ts

import { Module, Global } from '@nestjs/common';
import { PricingService } from './pricing.service';
import { PromotionResolver } from './promotion-resolver.service';
import { PromotionValidator } from './promotion-validator.service';
import { DiscountCalculator } from './discount-calculator.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PrismaModule } from 'src/prisma/prisma.module';

/**
 * Global module — available to ALL other modules without importing.
 * This ensures every service uses the SAME pricing engine instance.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    PricingService,
    PromotionResolver,
    PromotionValidator,
    DiscountCalculator,
    PrismaService,
  ],
  exports: [
    PricingService, // Main entry point for consumers
    PromotionResolver, // Exported for cache invalidation
  ],
})
export class PricingModule {}
