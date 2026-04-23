// Polyfill crypto for TypeORM compatibility
import * as crypto from 'crypto';
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = crypto as any;
}

import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { ApiHistoryInterceptor } from './common/interceptors/api-history.interceptor';
import { ProductsModule } from './modules/products/products.module';
import { AdminOrdersModule } from './modules/admin-orders/admin-orders.module';
import { AdminCustomersModule } from './modules/admin-customers/admin-customers.module';
import { AdminCompaniesModule } from './modules/admin-companies/admin-companies.module';
import { AdminCouponsModule } from './modules/admin-coupons/admin-coupons.module';
import { AdminLocationsModule } from './modules/admin-locations/admin-locations.module';
import { AdminQuotesModule } from './modules/admin-quotes/admin-quotes.module';
import { AdminSettingsModule } from './modules/admin-settings/admin-settings.module';
import { AdminUsersModule } from './modules/admin-users/admin-users.module';
import { AdminRolesModule } from './modules/admin-roles/admin-roles.module';
import { AdminCategoriesModule } from './modules/admin-categories/admin-categories.module';
import { AdminOptionsModule } from './modules/admin-options/admin-options.module';
import { AdminInvoicesModule } from './modules/admin-invoices/admin-invoices.module';
import { AdminUploadModule } from './modules/admin-upload/admin-upload.module';
import { AdminPaymentsModule } from './modules/admin-payments/admin-payments.module';
import { AdminReportsModule } from './modules/admin-reports/admin-reports.module';
import { AdminSubscriptionsModule } from './modules/admin-subscriptions/admin-subscriptions.module';
import { AdminNotificationsModule } from './modules/admin-notifications/admin-notifications.module';
import { AdminFeedbackModule } from './modules/admin-feedback/admin-feedback.module';
import { AdminCateringModule } from './modules/admin-catering/admin-catering.module';
import { AdminContactInquiriesModule } from './modules/admin-contact-inquiries/admin-contact-inquiries.module';
import { AdminWholesaleEnquiriesModule } from './modules/admin-wholesale-enquiries/admin-wholesale-enquiries.module';
import { AdminProductsModule } from './modules/admin-products/admin-products.module';
import { AdminBlogsModule } from './modules/admin-blogs/admin-blogs.module';
import { AdminReviewsModule } from './modules/admin-reviews/admin-reviews.module';
import { AdminEmailConfigModule } from './modules/admin-email-config/admin-email-config.module';
import { AdminHistoryModule } from './modules/admin-history/admin-history.module';
import { AdminNewsletterModule } from './modules/admin-newsletter/admin-newsletter.module';
import { StoreProductsModule } from './modules/store-products/store-products.module';
import { StoreOrdersModule } from './modules/store-orders/store-orders.module';
import { StoreCartModule } from './modules/store-cart/store-cart.module';
import { StorePaymentModule } from './modules/store-payment/store-payment.module';
import { StoreLocationsModule } from './modules/store-locations/store-locations.module';
import { StoreCouponsModule } from './modules/store-coupons/store-coupons.module';
import { StoreSubscriptionsModule } from './modules/store-subscriptions/store-subscriptions.module';
import { StoreAuthModule } from './modules/store-auth/store-auth.module';
import { StoreQuotesModule } from './modules/store-quotes/store-quotes.module';
import { StoreContactModule } from './modules/store-contact/store-contact.module';
import { StoreNewsletterModule } from './modules/store-newsletter/store-newsletter.module';
import { StoreWholesaleEnquiryModule } from './modules/store-wholesale-enquiry/store-wholesale-enquiry.module';
import { StoreBlogsModule } from './modules/store-blogs/store-blogs.module';
import { StoreReviewsModule } from './modules/store-reviews/store-reviews.module';
import { StoreChatbotModule } from './modules/store-chatbot/store-chatbot.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ScheduleModule.forRoot(), // Enable cron jobs
    ConfigModule,
    DatabaseModule,
    AuthModule,
    CommonModule, // Common services (Email, S3, Invoice)
    ProductsModule,
    // Admin Modules
    AdminOrdersModule,
    AdminCustomersModule,
    AdminCompaniesModule,
    AdminCouponsModule,
    AdminLocationsModule,
    AdminQuotesModule,
    AdminSettingsModule,
    AdminUsersModule,
    AdminRolesModule,
    AdminCategoriesModule,
    AdminOptionsModule,
    AdminInvoicesModule,
    AdminUploadModule,
    AdminPaymentsModule,
    AdminReportsModule,
    AdminSubscriptionsModule,
    AdminNotificationsModule,
    AdminFeedbackModule,
    AdminCateringModule,
    AdminContactInquiriesModule,
    AdminWholesaleEnquiriesModule,
    AdminProductsModule,
    AdminBlogsModule,
    AdminReviewsModule,
    AdminEmailConfigModule,
    AdminHistoryModule,
    AdminNewsletterModule,
    // Store Modules
    StoreProductsModule,
    StoreOrdersModule,
    StoreCartModule,
    StorePaymentModule,
    StoreLocationsModule,
    StoreCouponsModule,
    StoreSubscriptionsModule,
    StoreAuthModule,
    StoreQuotesModule,
    StoreContactModule,
    StoreNewsletterModule,
    StoreWholesaleEnquiryModule,
    StoreBlogsModule,
    StoreReviewsModule,
    StoreChatbotModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ApiHistoryInterceptor,
    },
  ],
})
export class AppModule { }
