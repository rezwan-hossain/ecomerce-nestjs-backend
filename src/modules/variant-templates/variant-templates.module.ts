import { Module } from '@nestjs/common';
import { VariantTemplatesController } from './variant-templates.controller';
import { VariantTemplatesService } from './variant-templates.service';
import { PrismaService } from 'src/prisma/prisma.service';

@Module({
  controllers: [VariantTemplatesController],
  providers: [VariantTemplatesService, PrismaService],
  exports: [VariantTemplatesService],
})
export class VariantTemplatesModule {}
