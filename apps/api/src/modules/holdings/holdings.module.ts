import { Module } from '@nestjs/common';
import { HoldingsService } from './holdings.service';

@Module({
  providers: [HoldingsService],
  exports: [HoldingsService],
})
export class HoldingsModule {}
