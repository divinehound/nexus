import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { CashflowController } from './cashflow.controller';
import { CashflowService } from './cashflow.service';

@Module({
  imports: [AdminModule],
  controllers: [CashflowController],
  providers: [CashflowService],
})
export class CashflowModule {}
