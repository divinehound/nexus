import { Module } from '@nestjs/common';
import { HoldingsService } from './holdings.service';
import { SearchModule } from '../search/search.module';

@Module({
  imports: [SearchModule],
  providers: [HoldingsService],
  exports: [HoldingsService],
})
export class HoldingsModule {}
