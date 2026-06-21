import { Module, forwardRef } from '@nestjs/common';
import { AdminSubscriptionsController } from './admin-subscriptions.controller';
import { AdminSubscriptionsService } from './admin-subscriptions.service';
import { SubscriptionSchedulerService } from './subscription-scheduler.service';
import { SubscriptionCronService } from './subscription-cron.service';
import { CommonModule } from '../../common/common.module';
import { AdminOrdersModule } from '../admin-orders/admin-orders.module';

@Module({
  imports: [CommonModule, forwardRef(() => AdminOrdersModule)],
  controllers: [AdminSubscriptionsController],
  providers: [AdminSubscriptionsService, SubscriptionSchedulerService, SubscriptionCronService],
  exports: [AdminSubscriptionsService, SubscriptionSchedulerService],
})
export class AdminSubscriptionsModule {}
