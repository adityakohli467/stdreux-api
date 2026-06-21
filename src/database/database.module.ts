import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getDatabaseConfig } from '../config/database.config';

// Import entities
import { Order } from '../entities/Order';
import { Customer } from '../entities/Customer';
import { Product } from '../entities/Product';
import { Company } from '../entities/Company';
import { Department } from '../entities/Department';
import { Category } from '../entities/Category';
import { OrderProduct } from '../entities/OrderProduct';
import { OrderProductOption } from '../entities/OrderProductOption';
import { Coupon } from '../entities/Coupon';
import { Location } from '../entities/Location';
import { Setting } from '../entities/Setting';
import { PaymentHistory } from '../entities/PaymentHistory';
import { User } from '../entities/User';
import { Blog } from '../entities/Blog';
import { ProductReview } from '../entities/ProductReview';
import { GeneralReview } from '../entities/GeneralReview';
import { ApiHistory } from '../entities/ApiHistory.entity';
import { Option } from '../entities/Option';
import { OptionValue } from '../entities/OptionValue';
import { ProductImage } from '../entities/ProductImage';
import { Role } from '../entities/Role';
import { UserRole } from '../entities/UserRole';
import { Permission } from '../entities/Permission';
import { CustomerProductDiscount } from '../entities/CustomerProductDiscount';
import { CustomerProductOptionDiscount } from '../entities/CustomerProductOptionDiscount';
import { CompanyProductDiscount } from '../entities/CompanyProductDiscount';
import { CompanyProductOptionDiscount } from '../entities/CompanyProductOptionDiscount';
import { FutureOrder } from '../entities/FutureOrder';
import { Notification } from '../entities/Notification';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => getDatabaseConfig(configService),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([
      Order,
      Customer,
      Product,
      Company,
      Department,
      Category,
      OrderProduct,
      OrderProductOption,
      Coupon,
      Location,
      Setting,
      PaymentHistory,
      User,
      Blog,
      ProductReview,
      GeneralReview,
      ApiHistory,
      Option,
      OptionValue,
      ProductImage,
      Role,
      UserRole,
      Permission,
      CustomerProductDiscount,
      CustomerProductOptionDiscount,
      CompanyProductDiscount,
      CompanyProductOptionDiscount,
      FutureOrder,
      Notification,
    ]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}

