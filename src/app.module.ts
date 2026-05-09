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

import 'dotenv/config';

@Module({
  imports: [AppLoggerModule, UsersModule, ProductsModule, PrismaModule, CategoriesModule],
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
