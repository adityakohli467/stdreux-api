import { Module } from '@nestjs/common';
import { StoreSubscriptionsController } from './store-subscriptions.controller';
import { StoreSubscriptionsService } from './store-subscriptions.service';
import { CommonModule } from '../../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [StoreSubscriptionsController],
  providers: [StoreSubscriptionsService],
  exports: [StoreSubscriptionsService],
})
export class StoreSubscriptionsModule {}
