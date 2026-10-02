import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CartsModule } from '../carts/carts.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [CartsModule, InventoryModule],
  controllers: [OrdersController],
  providers: [OrdersService, PrismaService],
  exports: [OrdersService],
})
export class OrdersModule {}
