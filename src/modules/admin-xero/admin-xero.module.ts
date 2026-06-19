import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { AdminXeroController } from './admin-xero.controller';
import { XeroWebhookController } from './xero-webhook.controller';
import { AdminXeroService } from './admin-xero.service';

@Module({
  imports: [ConfigModule],
  controllers: [AdminXeroController, XeroWebhookController],
  providers: [AdminXeroService],
  exports: [AdminXeroService],
})
export class AdminXeroModule {}
