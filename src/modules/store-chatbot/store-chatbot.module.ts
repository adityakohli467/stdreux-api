import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CommonModule } from '../../common/common.module';
import { StoreChatbotController } from './store-chatbot.controller';
import { StoreChatbotService } from './store-chatbot.service';

@Module({
  imports: [
    CommonModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') || 'supersecret',
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [StoreChatbotController],
  providers: [StoreChatbotService],
  exports: [StoreChatbotService],
})
export class StoreChatbotModule {}
