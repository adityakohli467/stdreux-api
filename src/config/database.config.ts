import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
// Import entities that ApiHistory depends on to ensure proper metadata resolution
import { ApiHistory } from '../entities/ApiHistory.entity';
import { User } from '../entities/User';
import { Customer } from '../entities/Customer';
import { Role } from '../entities/Role';
import { UserRole } from '../entities/UserRole';
import { Permission } from '../entities/Permission';
import { Company } from '../entities/Company';
import { Department } from '../entities/Department';
import { Order } from '../entities/Order';
import { Location } from '../entities/Location';
import { OrderProduct } from '../entities/OrderProduct';
import { OrderProductOption } from '../entities/OrderProductOption';
import { Product } from '../entities/Product';
import { Category } from '../entities/Category';
import { ProductImage } from '../entities/ProductImage';
import { PaymentHistory } from '../entities/PaymentHistory';
import { Option } from '../entities/Option';
import { OptionValue } from '../entities/OptionValue';
import { Blog } from '../entities/Blog';
import { ProductReview } from '../entities/ProductReview';
import { GeneralReview } from '../entities/GeneralReview';
import { Setting } from '../entities/Setting';
import { Coupon } from '../entities/Coupon';
import { CustomerProductDiscount } from '../entities/CustomerProductDiscount';
import { CustomerProductOptionDiscount } from '../entities/CustomerProductOptionDiscount';
import { CompanyProductDiscount } from '../entities/CompanyProductDiscount';
import { CompanyProductOptionDiscount } from '../entities/CompanyProductOptionDiscount';
import { FutureOrder } from '../entities/FutureOrder';
import { Notification } from '../entities/Notification';

/**
 * Get database configuration with automatic SSL detection for AWS RDS
 * This centralizes all database configuration logic
 */
export const getDatabaseConfig = (configService: ConfigService): TypeOrmModuleOptions => {
  // Single database configuration - uses DATABASE_URL environment variable
  const dbUrl = 
    configService.get<string>('DATABASE_URL') || 
    'postgresql://postgres:postgres@localhost:5432/stdurex_db';

  // SSL Detection Logic:
  // - Enable SSL for ANY non-localhost connection (AWS, RDS, remote servers)
  // - Disable SSL only for localhost in development
  // - Can be forced with DB_SSL=true environment variable
  const isLocalhost = 
    dbUrl.includes('localhost') || 
    dbUrl.includes('127.0.0.1') || 
    dbUrl.includes('::1');

  const useSSL = 
    !isLocalhost ||  // Not localhost = enable SSL (AWS, RDS, etc.)
    configService.get<string>('DB_SSL') === 'true' ||  // Explicitly enabled
    dbUrl.includes('rds.amazonaws.com') ||  // AWS RDS
    dbUrl.includes('.rds.') ||  // Any RDS endpoint pattern
    configService.get<string>('NODE_ENV') === 'production' ||  // Production = use SSL
    dbUrl.includes('?ssl=true') ||  // URL parameter
    dbUrl.includes('?sslmode=require');  // URL parameter

  return {
    type: 'postgres',
    url: dbUrl,
    entities: [
      __dirname + '/../**/*.entity{.ts,.js}',
      // Explicitly include entities with relations to ensure proper metadata resolution
      // This ensures TypeORM can build metadata for all relations in the correct order
      ApiHistory,
      User,
      Customer,
      Role,
      UserRole,
      Permission,
      Company,
      Department,
      Order,
      Location,
      OrderProduct,
      OrderProductOption,
      Product,
      Category,
      ProductImage,
      PaymentHistory,
      Option,
      OptionValue,
      Blog,
      ProductReview,
      GeneralReview,
      Setting,
      Coupon,
      CustomerProductDiscount,
      CustomerProductOptionDiscount,
      CompanyProductDiscount,
      CompanyProductOptionDiscount,
      FutureOrder,
      Notification,
    ],
    synchronize: false, // Never use synchronize in production - use migrations
    logging: configService.get<string>('NODE_ENV') === 'development',
    extra: {
      max: 20, // Maximum pool size
      connectionTimeoutMillis: 2000,
      ssl: useSSL ? {
        rejectUnauthorized: false, // Accept self-signed certificates for AWS RDS
      } : false,
    },
  };
};

