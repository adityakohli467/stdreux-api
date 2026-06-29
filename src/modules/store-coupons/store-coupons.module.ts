import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StoreCouponsController } from './store-coupons.controller';
import { StoreCouponsService } from './store-coupons.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') || 'supersecret',
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [StoreCouponsController],
  providers: [StoreCouponsService],
  exports: [StoreCouponsService],
})
export class StoreCouponsModule {}
