import { Module } from '@nestjs/common';
import { OptionsController } from './options.controller';
import { OptionsService } from './options.service';
import { PrismaService } from 'src/prisma/prisma.service';

@Module({
  controllers: [OptionsController],
  providers: [OptionsService, PrismaService],
  exports: [OptionsService],
})
export class OptionsModule {}
