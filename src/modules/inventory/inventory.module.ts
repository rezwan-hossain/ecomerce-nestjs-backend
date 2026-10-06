import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { StorageLocationsController } from './storage-locations.controller';
import { StorageLocationsService } from './storage-locations.service';
import { FloorPlanController } from './floor-plan.controller';
import { FloorPlanService } from './floor-plan/floor-plan.service';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [
    InventoryController,
    StorageLocationsController,
    FloorPlanController,
  ],
  providers: [InventoryService, StorageLocationsService, FloorPlanService],
  exports: [InventoryService],
})
export class InventoryModule {}
