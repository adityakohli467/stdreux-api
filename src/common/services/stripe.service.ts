import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import Stripe from 'stripe';

export interface StripePaymentIntentRequest {
  amount: number; // Amount in cents (e.g., 12500 for $125.00)
  currency: string; // 'aud'
  orderId: string; // Your order ID
  customerEmail: string;
  customerName?: string;
  customerPhone?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface StripePaymentIntentResponse {
  clientSecret: string;
  paymentIntentId: string;
  status: 'requires_payment_method' | 'requires_confirmation' | 'requires_action' | 'processing' | 'succeeded' | 'canceled';
}

export interface StripeRefundRequest {
  paymentIntentId: string;
  amount?: number; // Optional, defaults to full refund (in cents)
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
}

export interface StripeRefundResponse {
  refundId: string;
  paymentIntentId: string;
  amount: number;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  createdAt: number;
}

export interface StripePaymentIntentStatus {
  paymentIntentId: string;
  status: 'requires_payment_method' | 'requires_confirmation' | 'requires_action' | 'processing' | 'succeeded' | 'canceled';
  amount: number;
  currency: string;
  orderId?: string;
  paymentMethod?: string;
  createdAt: number;
  metadata?: Record<string, string>;
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private stripe: Stripe;
  private secretKey: string;
  private publishableKey: string;
  private testMode: boolean;

  constructor(
    private configService: ConfigService,
    private dataSource: DataSource,
  ) {
    // Initialize with default values, will be updated from settings
    this.secretKey = '';
    this.publishableKey = '';
    this.testMode = true;
  }

  /**
   * Initialize Stripe service from settings
   */
  async initialize(): Promise<void> {
    const settingsQuery = `
      SELECT setting_key, setting_value 
      FROM settings 
      WHERE setting_key IN (
        'stripe_secret_key', 
        'stripe_publishable_key', 
        'stripe_test_mode',
        'stripe_webhook_secret'
      )
    `;

    const result = await this.dataSource.query(settingsQuery);
    const settings: Record<string, string> = {};

    result.forEach((row: any) => {
      settings[row.setting_key] = row.setting_value;
    });

    // Fallback to environment variables if settings not found
    this.secretKey =
      settings.stripe_secret_key ||
      this.configService.get<string>('STRIPE_SECRET_KEY') ||
      '';
    this.publishableKey =
      settings.stripe_publishable_key ||
      this.configService.get<string>('STRIPE_PUBLISHABLE_KEY') ||
      '';
    this.testMode =
      settings.stripe_test_mode === 'true' ||
      settings.stripe_test_mode === '1' ||
      this.configService.get<string>('STRIPE_TEST_MODE', 'true') === 'true';

    if (!this.secretKey) {
      this.logger.warn('Stripe secret key not configured. Payment processing will fail.');
      return;
    }

    this.stripe = new Stripe(this.secretKey, {
      apiVersion: '2025-11-17.clover' as any,
      typescript: true,
    });

    this.logger.log(`Stripe initialized in ${this.testMode ? 'TEST' : 'LIVE'} mode`);
  }

  /**
   * Create a Payment Intent
   * This is used for client-side payment processing with Stripe Elements
   */
  async createPaymentIntent(
    paymentData: StripePaymentIntentRequest,
  ): Promise<StripePaymentIntentResponse> {
    await this.initialize();

    if (!this.stripe) {
      throw new Error('Stripe not initialized. Please configure Stripe secret key.');
    }

    try {
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: paymentData.amount, // Amount in cents
        currency: paymentData.currency.toLowerCase(),
        metadata: {
          order_id: paymentData.orderId,
          customer_email: paymentData.customerEmail,
          ...paymentData.metadata,
        },
        description: paymentData.description || `Order #${paymentData.orderId}`,
        receipt_email: paymentData.customerEmail,
        automatic_payment_methods: {
          enabled: true,
        },
      });

      return {
        clientSecret: paymentIntent.client_secret || '',
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status as any,
      };
    } catch (error: any) {
      this.logger.error(
        'Stripe create payment intent error:',
        error.message || error,
      );
      throw new Error(
        error.message || 'Failed to create payment intent',
      );
    }
  }

  /**
   * Retrieve Payment Intent status
   */
  async getPaymentIntentStatus(
    paymentIntentId: string,
  ): Promise<StripePaymentIntentStatus> {
    await this.initialize();

    if (!this.stripe) {
      throw new Error('Stripe not initialized. Please configure Stripe secret key.');
    }

    try {
      const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);

      return {
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status as any,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        orderId: paymentIntent.metadata?.order_id,
        paymentMethod: paymentIntent.payment_method as string,
        createdAt: paymentIntent.created,
        metadata: paymentIntent.metadata as Record<string, string>,
      };
    } catch (error: any) {
      this.logger.error(
        'Stripe get payment intent error:',
        error.message || error,
      );
      throw new Error(
        error.message || 'Failed to retrieve payment intent status',
      );
    }
  }

  /**
   * Cancel a Payment Intent (only if it hasn't succeeded)
   */
  async cancelPaymentIntent(paymentIntentId: string): Promise<{ success: boolean; status: string }> {
    await this.initialize();

    if (!this.stripe) {
      throw new Error('Stripe not initialized. Please configure Stripe secret key.');
    }

    try {
      const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);

      // Only cancel if not already succeeded or canceled
      if (paymentIntent.status === 'succeeded' || paymentIntent.status === 'canceled') {
        return { success: true, status: paymentIntent.status };
      }

      const canceled = await this.stripe.paymentIntents.cancel(paymentIntentId);
      this.logger.log(`[Stripe] Canceled payment intent: ${paymentIntentId}`);
      return { success: true, status: canceled.status };
    } catch (error: any) {
      this.logger.warn(`[Stripe] Failed to cancel intent ${paymentIntentId}: ${error.message}`);
      // Don't throw - cancellation failure is non-critical
      return { success: false, status: 'cancel_failed' };
    }
  }

  /**
   * Create a refund
   */
  async createRefund(
    refundData: StripeRefundRequest,
  ): Promise<StripeRefundResponse> {
    await this.initialize();

    if (!this.stripe) {
      throw new Error('Stripe not initialized. Please configure Stripe secret key.');
    }

    try {
      const refund = await this.stripe.refunds.create({
        payment_intent: refundData.paymentIntentId,
        amount: refundData.amount, // Optional, defaults to full refund
        reason: refundData.reason || 'requested_by_customer',
      });

      return {
        refundId: refund.id,
        paymentIntentId: refundData.paymentIntentId,
        amount: refund.amount,
        status: refund.status as any,
        createdAt: refund.created,
      };
    } catch (error: any) {
      this.logger.error(
        'Stripe refund error:',
        error.message || error,
      );
      throw new Error(
        error.message || 'Failed to create refund',
      );
    }
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(
    payload: string | Buffer,
    signature: string,
    webhookSecret: string,
  ): Stripe.Event {
    if (!this.stripe) {
      throw new Error('Stripe not initialized. Please configure Stripe secret key.');
    }

    try {
      const event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        webhookSecret,
      );
      return event;
    } catch (error: any) {
      this.logger.error('Webhook signature verification error:', error.message);
      throw new Error(`Webhook signature verification failed: ${error.message}`);
    }
  }

  /**
   * Get publishable key (for frontend)
   */
  async getPublishableKey(): Promise<string> {
    await this.initialize();
    return this.publishableKey;
  }

  /**
   * Confirm a payment intent (for server-side confirmation if needed)
   */
  async confirmPaymentIntent(
    paymentIntentId: string,
    paymentMethodId?: string,
  ): Promise<Stripe.PaymentIntent> {
    await this.initialize();

    if (!this.stripe) {
      throw new Error('Stripe not initialized. Please configure Stripe secret key.');
    }

    try {
      const params: Stripe.PaymentIntentConfirmParams = {};
      if (paymentMethodId) {
        params.payment_method = paymentMethodId;
      }

      const paymentIntent = await this.stripe.paymentIntents.confirm(
        paymentIntentId,
        params,
      );

      return paymentIntent;
    } catch (error: any) {
      this.logger.error(
        'Stripe confirm payment intent error:',
        error.message || error,
      );
      throw new Error(
        error.message || 'Failed to confirm payment intent',
      );
    }
  }
}

