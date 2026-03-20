import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { MeService } from './me.service';
import { HoldingsModule } from '../holdings/holdings.module';

@Module({
  imports: [HoldingsModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
