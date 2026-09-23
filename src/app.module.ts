import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UsersModule } from './modules/users/users.module';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { ProductsModule } from './modules/products/products.module';
import { PrismaModule } from './prisma/prisma.module';
import { AppLoggerModule } from './common/logger/logger.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { BrandsModule } from './modules/brands/brands.module';
import { TagsModule } from './modules/tags/tags.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { PromotionsModule } from './modules/promotions/promotions.module';
import { OptionsModule } from './modules/options/options.module';
import { CartsModule } from './modules/carts/carts.module';
import { OrdersModule } from './modules/orders/orders.module';

import 'dotenv/config';
import { PricingModule } from './modules/pricings/pricing.module';

@Module({
  imports: [
    AppLoggerModule,
    UsersModule,
    PricingModule,
    ProductsModule,
    PrismaModule,
    CategoriesModule,
    BrandsModule,
    TagsModule,
    CampaignsModule,
    PromotionsModule,
    OptionsModule,
    CartsModule,
    OrdersModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
  ],
})
export class AppModule {}
