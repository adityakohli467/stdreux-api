import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import axios from 'axios';
import { StripeService } from '../../common/services/stripe.service';
import { EmailService } from '../../common/services/email.service';

@Injectable()
export class AdminPaymentsService {
  private readonly logger = new Logger(AdminPaymentsService.name);

  constructor(
    private dataSource: DataSource,
    private stripeService: StripeService,
    private emailService: EmailService,
    private configService: ConfigService,
  ) { }


  /**
   * Payment History Service methods
   */
  async recordPayment(record: any): Promise<number> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await queryRunner.query(
        `INSERT INTO payment_history (
          order_id, payment_transaction_id, payment_type, payment_status,
          payment_gateway, amount, currency, gateway_response, request_id, idempotency_key,
          customer_email, customer_id, card_token, payment_method, ip_address, user_agent, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING payment_history_id`,
        [
          record.order_id, record.payment_transaction_id, record.payment_type,
          record.payment_status, record.payment_gateway, record.amount,
          record.currency || 'AUD', JSON.stringify(record.gateway_response),
          record.request_id || crypto.randomUUID(), record.idempotency_key || crypto.randomUUID(),
          record.customer_email, record.customer_id, record.card_token,
          record.payment_method, record.ip_address, record.user_agent,
          record.metadata ? JSON.stringify(record.metadata) : null
        ]
      );
      await queryRunner.commitTransaction();
      return result[0].payment_history_id;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async updatePaymentStatus(transactionId: string, status: string, gatewayResponse?: any, gatewayError?: any): Promise<void> {
    await this.dataSource.query(
      `UPDATE payment_history 
       SET payment_status = $1, gateway_response = COALESCE($2::jsonb, gateway_response),
           gateway_error = COALESCE($3::jsonb, gateway_error), updated_at = CURRENT_TIMESTAMP
       WHERE payment_transaction_id = $4`,
      [status, gatewayResponse ? JSON.stringify(gatewayResponse) : null, gatewayError ? JSON.stringify(gatewayError) : null, transactionId]
    );
  }

  async getOrderPaymentHistory(orderId: number): Promise<any[]> {
    const result = await this.dataSource.query(
      `SELECT * FROM payment_history WHERE order_id = $1 ORDER BY created_at DESC`,
      [orderId]
    );
    return result;
  }

  async getPaymentByTransactionId(transactionId: string): Promise<any | null> {
    const result = await this.dataSource.query(
      'SELECT * FROM payment_history WHERE payment_transaction_id = $1',
      [transactionId]
    );
    return result[0] || null;
  }

  static sanitizePaymentResponse(response: any): any {
    if (!response) return null;
    const sanitized = { ...response };
    if (sanitized.response?.card) {
      delete sanitized.response.card.number;
      delete sanitized.response.card.cvc;
    }
    return sanitized;
  }

  /**
   * Create Stripe Payment Intent for admin payment processing
   * This creates a payment intent that can be used with Stripe Elements
   */
  async createPaymentIntent(orderId: number, email: string, ipAddress?: string, userAgent?: string) {
    // Get order details
    const orderQuery = `
      SELECT 
        o.order_id,
        o.order_total,
        o.order_status,
        o.payment_status,
        o.customer_id,
        o.delivery_fee,
        o.coupon_discount,
        c.email as customer_email,
        c.firstname,
        c.lastname,
        c.telephone as customer_phone
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      WHERE o.order_id = $1
    `;
    const orderResult = await this.dataSource.query(orderQuery, [orderId]);
    const order = orderResult[0];

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // Check if already paid
    if (order.order_status === 2 || order.payment_status === 'paid' || order.payment_status === 'succeeded') {
      const existingPayments = await this.getOrderPaymentHistory(orderId);
      const successfulPayments = existingPayments.filter((p: any) => p.payment_status === 'succeeded' && p.payment_type === 'charge');

      if (successfulPayments.length > 0) {
        throw new BadRequestException({
          message: 'Order already paid',
          payment_history: successfulPayments.map((p: any) => ({
            transaction_id: p.payment_transaction_id,
            amount: p.amount,
            status: p.payment_status,
            created_at: p.created_at
          }))
        });
      }
    }

    // Initialize Stripe service
    await this.stripeService.initialize();

    // Recalculate total from order_product rows to ensure consistency with edited orders
    const productTotalQuery = `
      SELECT COALESCE(SUM(op.total), 0) as subtotal
      FROM order_product op
      WHERE op.order_id = $1
    `;
    const productTotalResult = await this.dataSource.query(productTotalQuery, [orderId]);
    const subtotalFromProducts = parseFloat(productTotalResult[0]?.subtotal || 0);
    const deliveryFee = parseFloat(order.delivery_fee || 0);
    const couponDiscount = parseFloat(order.coupon_discount || 0);
    const recalculatedTotal = Math.max(0, subtotalFromProducts + deliveryFee - couponDiscount);

    // Use recalculated total (more reliable than stored order_total after edits)
    const totalAmount = recalculatedTotal > 0 ? recalculatedTotal : parseFloat(order.order_total || 0);
    const totalAmountCents = Math.round(totalAmount * 100);

    if (totalAmountCents <= 0) {
      throw new BadRequestException('Order total must be greater than zero');
    }

    // Create Stripe Payment Intent
    const paymentIntent = await this.stripeService.createPaymentIntent({
      amount: totalAmountCents,
      currency: 'aud',
      orderId: order.order_id.toString(),
      customerEmail: email || order.customer_email || '',
      customerName: `${order.firstname || ''} ${order.lastname || ''}`.trim() || undefined,
      customerPhone: order.customer_phone || undefined,
      description: `Order #${order.order_id}`,
      metadata: {
        order_id: order.order_id.toString(),
        customer_id: order.customer_id?.toString() || '',
        admin_payment: 'true',
      },
    });

    // Store payment intent in database
    const idempotencyKey = `admin_order_${orderId}_${Date.now()}`;
    const requestId = crypto.randomUUID();

    await this.recordPayment({
      order_id: orderId,
      payment_transaction_id: paymentIntent.paymentIntentId,
      payment_type: 'payment_intent',
      payment_status: 'pending',
      payment_gateway: 'stripe',
      amount: totalAmount,
      currency: 'AUD',
      customer_email: email || order.customer_email,
      customer_id: order.customer_id,
      gateway_response: {
        ...paymentIntent,
        session_created_at: new Date().toISOString(),
        order_total: totalAmount,
      },
      ip_address: ipAddress,
      user_agent: userAgent,
      request_id: requestId,
      idempotency_key: idempotencyKey,
      metadata: {
        order_id: order.order_id,
        customer_id: order.customer_id,
        admin_initiated: true,
      },
    });

    return {
      success: true,
      client_secret: paymentIntent.clientSecret,
      payment_intent_id: paymentIntent.paymentIntentId,
      order_id: order.order_id,
      amount: totalAmount,
      currency: 'AUD',
    };
  }

  /**
   * Process refund
   */
  async processRefund(orderId: number, amount?: number) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Get order details
      const orderQuery = `
        SELECT 
          order_id,
          order_total,
          payment_transaction_id,
          payment_status,
          payment_response,
          customer_id
        FROM orders
        WHERE order_id = $1
      `;
      const orderResult = await queryRunner.query(orderQuery, [orderId]);
      const order = orderResult[0];

      if (!order) {
        throw new NotFoundException('Order not found');
      }

      if (!order.payment_transaction_id) {
        throw new BadRequestException('Order has no payment transaction');
      }

      if (order.payment_status !== 'succeeded') {
        throw new BadRequestException('Can only refund successful payments');
      }

      // Use Stripe refund method
      const refundAmount = amount || parseFloat(order.order_total);

      // Call the Stripe refund method
      const refundResult = await this.processStripeRefund(
        order.payment_transaction_id,
        refundAmount,
        'requested_by_customer',
        undefined,
        undefined,
        undefined
      );

      await queryRunner.commitTransaction();

      return {
        success: true,
        refund_id: refundResult.refund.refund_id,
        amount: refundResult.refund.amount / 100, // Convert from cents (already in cents from Stripe)
        currency: 'AUD',
        order_id: orderId
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Process Stripe refund
   */
  async processStripeRefund(paymentIntentId: string, amount?: number, reason?: string, userId?: number, ipAddress?: string, userAgent?: string) {
    if (!paymentIntentId) {
      throw new BadRequestException('Payment Intent ID is required');
    }

    // Initialize Stripe service
    await this.stripeService.initialize();

    // Create refund (convert amount to cents if provided)
    const refundAmountCents = amount ? Math.round(amount * 100) : undefined;
    const refund = await this.stripeService.createRefund({
      paymentIntentId: paymentIntentId,
      amount: refundAmountCents,
      reason: reason as any || 'requested_by_customer',
    });

    // Get payment history record
    const paymentHistoryQuery = await this.dataSource.query(
      `SELECT payment_history_id, order_id, payment_status, refund_amount, amount 
       FROM payment_history 
       WHERE payment_transaction_id = $1`,
      [paymentIntentId]
    );

    const paymentHistory = paymentHistoryQuery[0];
    if (!paymentHistory) {
      throw new NotFoundException('Payment not found');
    }

    const newRefundAmount = (parseFloat(paymentHistory.refund_amount || 0) + refund.amount);
    const newStatus = newRefundAmount >= parseFloat(paymentHistory.amount || 0) ? 'refunded' : paymentHistory.payment_status;

    // Update payment history
    await this.dataSource.query(
      `UPDATE payment_history 
       SET refund_amount = $1,
           payment_status = CASE 
             WHEN $1 >= amount THEN 'refunded'
             ELSE payment_status
           END,
           gateway_response = jsonb_set(
             COALESCE(gateway_response, '{}'::jsonb),
             '{refunds}',
             COALESCE(gateway_response->'refunds', '[]'::jsonb) || $2::jsonb
           ),
           updated_at = CURRENT_TIMESTAMP
       WHERE payment_transaction_id = $3`,
      [
        newRefundAmount,
        JSON.stringify([{
          refund_id: refund.refundId,
          refunded_at: new Date().toISOString(),
          refunded_by: userId?.toString() || 'admin',
          ...refund,
        }]),
        paymentIntentId,
      ]
    );

    // Log audit event
    await this.dataSource.query(
      `INSERT INTO payment_audit_log (
        payment_history_id,
        order_id,
        transaction_id,
        event_type,
        old_status,
        new_status,
        event_data,
        performed_by,
        ip_address,
        user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        paymentHistory.payment_history_id,
        paymentHistory.order_id,
        paymentIntentId,
        'refunded',
        paymentHistory.payment_status,
        newStatus,
        JSON.stringify({
          action: 'refund_processed',
          gateway: 'stripe',
          refund_id: refund.refundId,
          refund_amount: refund.amount / 100, // Convert from cents
          total_refunded: newRefundAmount,
          original_amount: paymentHistory.amount,
        }),
        userId?.toString() || 'admin',
        ipAddress || null,
        userAgent || null,
      ]
    );

    // Send refund confirmation email
    try {
      if (paymentHistory.order_id) {
        const orderQuery = await this.dataSource.query(
          `SELECT 
            o.order_id,
            o.customer_order_name,
            o.customer_order_email,
            o.order_total,
            c.email,
            c.firstname,
            c.lastname
          FROM orders o
          LEFT JOIN customer c ON o.customer_id = c.customer_id
          WHERE o.order_id = $1`,
          [paymentHistory.order_id],
        );

        if (orderQuery.length > 0) {
          const order = orderQuery[0];
          const customerName =
            order.customer_order_name ||
            `${order.firstname || ''} ${order.lastname || ''}`.trim() ||
            'Customer';
          const customerEmail = order.customer_order_email || order.email;
          const refundAmount = refund.amount / 100; // Convert from cents
          const isFullRefund = !amount || refund.amount >= parseFloat(paymentHistory.amount || 0);
          const companyName = this.configService.get<string>('COMPANY_NAME') || 'Sendrix';

          if (customerEmail) {
            const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 0 auto; background-color: #fff; padding: 20px; }
    .header { background-color: #28a745; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
    .refund-box { background-color: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin: 20px 0; }
    .amount { font-size: 24px; font-weight: bold; color: #28a745; margin: 20px 0; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Refund Processed - Order #${order.order_id}</h1>
    </div>
    <div class="content">
      <p>Dear ${customerName},</p>
      <p>We have processed a refund for your order #${order.order_id}.</p>
      
      <div class="refund-box">
        <h3>Refund Details</h3>
        <div class="amount">Refund Amount: $${refundAmount.toFixed(2)}</div>
        <p><strong>Refund Type:</strong> ${isFullRefund ? 'Full Refund' : 'Partial Refund'}</p>
        <p><strong>Refund ID:</strong> ${refund.refundId}</p>
        <p><strong>Refund Reason:</strong> ${reason || 'Requested by customer'}</p>
      </div>

      <p>The refund has been processed and should appear in your account within 5-10 business days, depending on your bank or card issuer.</p>

      ${isFullRefund ? '<p><strong>Note:</strong> This is a full refund. Your order has been cancelled.</p>' : ''}

      <p>If you have any questions about this refund, please don't hesitate to contact us.</p>
      
      <p>Thank you,<br/>${companyName} Team</p>
    </div>
    <div class="footer">
      <p>If you have any questions, please contact us.</p>
      <p>&copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
            `;

            await this.emailService.sendEmail({
              to: customerEmail,
              subject: `Refund Processed - Order #${order.order_id} - ${companyName}`,
              html: emailHtml,
            });

            this.logger.log(`Refund confirmation email sent to ${customerEmail} for order #${order.order_id}`);
          }
        }
      }
    } catch (emailError) {
      this.logger.error('Failed to send refund confirmation email:', emailError);
      // Don't fail the refund if email fails
    }

    // Update order status if full refund
    if (!amount || refund.amount >= parseFloat(paymentHistory.amount || 0)) {
      await this.dataSource.query(
        `UPDATE orders 
         SET payment_status = 'refunded',
             payment_response = jsonb_set(
               COALESCE(payment_response, '{}'::jsonb),
               '{refund}',
               $1::jsonb
             ),
             date_modified = CURRENT_TIMESTAMP
         WHERE order_id = $2`,
        [JSON.stringify(refund), paymentHistory.order_id]
      );
    }

    return {
      success: true,
      refund: {
        refund_id: refund.refundId,
        payment_intent_id: paymentIntentId,
        amount: refund.amount,
        status: refund.status,
      },
    };
  }

  /**
   * Get payment status for an order
   */
  async getPaymentStatus(orderId: number) {
    const query = `
      SELECT 
        o.order_id,
        o.payment_transaction_id,
        o.payment_status,
        o.payment_gateway,
        o.payment_date,
        o.payment_response,
        o.customer_id,
        o.order_total,
        c.email as customer_email
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      WHERE o.order_id = $1
    `;
    const result = await this.dataSource.query(query, [orderId]);

    if (result.length === 0) {
      throw new NotFoundException('Order not found');
    }

    const order = result[0];

    // If payment exists, try to get latest status from Stripe and ensure synchronization
    if (order.payment_transaction_id && order.payment_gateway === 'stripe') {
      try {
        await this.stripeService.initialize();
        const paymentIntent = await this.stripeService.getPaymentIntentStatus(order.payment_transaction_id);

        const stripeStatus = paymentIntent.status === 'succeeded' ? 'succeeded' : paymentIntent.status;
        
        // 1. Ensure order table is up to date
        if (stripeStatus !== order.payment_status) {
          await this.dataSource.query(
            `UPDATE orders 
             SET payment_status = $1,
                 payment_response = $2
             WHERE order_id = $3`,
            [stripeStatus, JSON.stringify(paymentIntent), orderId]
          );
          order.payment_status = stripeStatus;
        }

        // 2. Ensure payment_history record exists and is correct for successful payments
        if (stripeStatus === 'succeeded') {
          const existingHistory = await this.getPaymentByTransactionId(order.payment_transaction_id);
          if (!existingHistory) {
            this.logger.log(`[Sync] Creating missing payment history for order ${orderId} (Transaction: ${order.payment_transaction_id})`);
            
            await this.recordPayment({
              order_id: orderId,
              payment_transaction_id: order.payment_transaction_id,
              payment_type: 'charge',
              payment_status: 'succeeded',
              payment_gateway: 'stripe',
              amount: (paymentIntent.amount || (parseFloat(order.order_total) * 100)) / 100,
              currency: (paymentIntent.currency || 'aud').toUpperCase(),
              gateway_response: paymentIntent,
              customer_email: paymentIntent.metadata?.customer_email || order.customer_email || null,
              customer_id: order.customer_id || (paymentIntent.metadata?.customer_id ? parseInt(paymentIntent.metadata.customer_id) : null),
              payment_method: paymentIntent.paymentMethod || 'card',
              metadata: paymentIntent.metadata
            });
          } else if (existingHistory.payment_status !== 'succeeded') {
            this.logger.log(`[Sync] Updating existing payment history for order ${orderId} to succeeded`);
            await this.updatePaymentStatus(order.payment_transaction_id, 'succeeded', paymentIntent);
          }
        }
      } catch (error) {
        this.logger.error(`Error fetching/syncing payment status for order ${orderId}:`, error);
        // Continue with stored status
      }
    }

    return {
      order_id: order.order_id,
      payment_transaction_id: order.payment_transaction_id,
      payment_status: order.payment_status,
      payment_gateway: order.payment_gateway,
      payment_date: order.payment_date,
      payment_response: order.payment_response
    };
  }

  /**
   * Get payment history with filters
   */
  async getPaymentHistory(filters: {
    order_id?: number;
    customer_id?: number;
    payment_status?: string;
    payment_gateway?: string;
    date_from?: string;
    date_to?: string;
    limit?: number;
    offset?: number;
  }) {
    const {
      order_id,
      customer_id,
      payment_status,
      payment_gateway,
      date_from,
      date_to,
      limit = 50,
      offset = 0,
    } = filters;

    let query = `
      SELECT 
        ph.payment_history_id,
        ph.order_id,
        ph.payment_transaction_id,
        ph.payment_type,
        ph.payment_status,
        ph.payment_gateway,
        ph.amount,
        ph.currency,
        ph.refund_amount,
        ph.customer_id,
        ph.customer_email,
        ph.card_last4,
        ph.card_brand,
        ph.payment_method,
        ph.created_at,
        ph.updated_at,
        ph.processed_at,
        ph.gateway_response->>'status' as gateway_status,
        ph.gateway_response->>'message' as gateway_message,
        CASE 
          WHEN ph.gateway_error IS NOT NULL THEN true
          ELSE false
        END as has_error,
        o.order_total,
        o.order_status,
        o.delivery_date_time,
        o.delivery_fee,
        c.firstname || ' ' || c.lastname as customer_name
      FROM payment_history ph
      LEFT JOIN orders o ON ph.order_id = o.order_id
      LEFT JOIN customer c ON ph.customer_id = c.customer_id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (order_id) {
      query += ` AND ph.order_id = $${paramIndex}`;
      params.push(order_id);
      paramIndex++;
    }

    if (customer_id) {
      query += ` AND ph.customer_id = $${paramIndex}`;
      params.push(customer_id);
      paramIndex++;
    }

    if (payment_status) {
      query += ` AND ph.payment_status = $${paramIndex}`;
      params.push(payment_status);
      paramIndex++;
    } else {
      query += ` AND NOT (ph.payment_status = 'pending' AND ph.order_id IS NULL)`;
    }

    if (payment_gateway) {
      query += ` AND ph.payment_gateway = $${paramIndex}`;
      params.push(payment_gateway);
      paramIndex++;
    }

    if (date_from) {
      query += ` AND ph.created_at >= $${paramIndex}`;
      params.push(date_from);
      paramIndex++;
    }

    if (date_to) {
      query += ` AND ph.created_at <= $${paramIndex}`;
      params.push(date_to + ' 23:59:59');
      paramIndex++;
    }

    query += ` ORDER BY ph.created_at DESC`;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Math.min(limit, 500));
    params.push(offset);

    const result = await this.dataSource.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) as total
      FROM payment_history ph
      WHERE 1=1
    `;
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (order_id) {
      countQuery += ` AND ph.order_id = $${countParamIndex}`;
      countParams.push(order_id);
      countParamIndex++;
    }

    if (customer_id) {
      countQuery += ` AND ph.customer_id = $${countParamIndex}`;
      countParams.push(customer_id);
      countParamIndex++;
    }

    if (payment_status) {
      countQuery += ` AND ph.payment_status = $${countParamIndex}`;
      countParams.push(payment_status);
      countParamIndex++;
    } else {
      countQuery += ` AND NOT (ph.payment_status = 'pending' AND ph.order_id IS NULL)`;
    }

    if (payment_gateway) {
      countQuery += ` AND ph.payment_gateway = $${countParamIndex}`;
      countParams.push(payment_gateway);
      countParamIndex++;
    }

    if (date_from) {
      countQuery += ` AND ph.created_at >= $${countParamIndex}`;
      countParams.push(date_from);
      countParamIndex++;
    }

    if (date_to) {
      countQuery += ` AND ph.created_at <= $${countParamIndex}`;
      countParams.push(date_to + ' 23:59:59');
      countParamIndex++;
    }

    const countResult = await this.dataSource.query(countQuery, countParams);
    const total = parseInt(countResult[0].total);

    const payments = result.map((row: any) => {
      const orderTotal = parseFloat(row.order_total || 0);
      const deliveryFee = parseFloat(row.delivery_fee || 0);

      // Calculate GST and subtotal (consistent with AdminOrdersService)
      // GST is 1/11th of the total excluding delivery fee
      const gst = Math.round(((orderTotal - deliveryFee) / 11) * 100) / 100;
      const subtotal = Math.round((orderTotal - deliveryFee - gst) * 100) / 100;

      return {
        ...row,
        order_total: orderTotal,
        subtotal: subtotal,
        gst: gst,
        status_name: row.order_status === 5 ? 'Completed' : (row.order_status === 1 ? 'New' : (row.order_status === 2 ? 'Paid' : (row.order_status === 4 ? 'Awaiting Approval' : (row.order_status === 7 ? 'Approved' : 'Updated')))),
        delivery_date: row.delivery_date_time ? new Date(row.delivery_date_time).toISOString().split('T')[0] : null,
        delivery_time: row.delivery_date_time ? new Date(row.delivery_date_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : null,
      };
    });

    return {
      payments: payments,
      pagination: {
        total,
        limit,
        offset,
        has_more: total > offset + limit,
      },
    };
  }

  /**
   * Get order payment history (public method that sanitizes)
   */
  async getOrderPaymentHistoryPublic(orderId: number) {
    const payments = await this.getOrderPaymentHistory(orderId);

    // Sanitize sensitive data
    const sanitizedPayments = payments.map((payment: any) => ({
      ...payment,
      gateway_response: AdminPaymentsService.sanitizePaymentResponse(payment.gateway_response)
    }));

    return { payments: sanitizedPayments };
  }

  /**
   * Get payment audit log
   */
  async getPaymentAuditLog(transactionId: string) {
    const query = `
      SELECT 
        pal.*,
        ph.order_id,
        ph.amount,
        ph.currency
      FROM payment_audit_log pal
      JOIN payment_history ph ON pal.payment_history_id = ph.payment_history_id
      WHERE pal.transaction_id = $1
      ORDER BY pal.created_at ASC
    `;

    const result = await this.dataSource.query(query, [transactionId]);

    return {
      audit_log: result,
    };
  }

  /**
   * Sync recent payments missing from history
   */
  async syncRecentPayments() {
    // Find orders from last 7 days that should have a payment record but don't
    const missingHistoryQuery = `
      SELECT o.order_id
      FROM orders o
      LEFT JOIN payment_history ph ON o.order_id = ph.order_id
      WHERE (o.payment_status = 'succeeded' OR o.order_status = 2)
      AND ph.payment_history_id IS NULL
      AND o.date_added > (CURRENT_TIMESTAMP - INTERVAL '7 days')
      AND o.payment_transaction_id IS NOT NULL
      AND o.payment_gateway = 'stripe'
    `;
    const result = await this.dataSource.query(missingHistoryQuery);
    
    this.logger.log(`[Sync] Found ${result.length} orders with missing payment history to sync`);
    
    const syncedIds: number[] = [];
    for (const row of result) {
      try {
        await this.getPaymentStatus(row.order_id);
        syncedIds.push(row.order_id);
      } catch (err) {
        this.logger.error(`Failed to sync missing history for order ${row.order_id}:`, err);
      }
    }
    
    return {
      total_found: result.length,
      total_synced: syncedIds.length,
      synced_order_ids: syncedIds
    };
  }

  /**
   * Get payment statistics
   */
  async getPaymentStatistics(dateFrom?: string, dateTo?: string) {
    let dateFilter = '';
    const params: any[] = [];
    if (dateFrom && dateTo) {
      dateFilter = 'WHERE ph.created_at >= $1 AND ph.created_at <= $2';
      params.push(dateFrom, dateTo + ' 23:59:59');
    }

    const query = `
      SELECT 
        COUNT(*) as total_transactions,
        COUNT(CASE WHEN payment_status = 'succeeded' THEN 1 END) as successful_payments,
        COUNT(CASE WHEN payment_status = 'failed' THEN 1 END) as failed_payments,
        COUNT(CASE WHEN payment_status = 'pending' THEN 1 END) as pending_payments,
        COUNT(CASE WHEN payment_status = 'refunded' THEN 1 END) as refunded_payments,
        SUM(CASE WHEN payment_status = 'succeeded' THEN amount ELSE 0 END) as total_revenue,
        SUM(refund_amount) as total_refunds,
        SUM(CASE WHEN payment_status = 'succeeded' THEN amount ELSE 0 END) - COALESCE(SUM(refund_amount), 0) as net_revenue,
        COUNT(DISTINCT customer_id) as unique_customers,
        COUNT(DISTINCT order_id) as unique_orders
      FROM payment_history ph
      ${dateFilter}
    `;

    const result = await this.dataSource.query(query, params);

    return {
      statistics: result[0],
      period: {
        from: dateFrom || null,
        to: dateTo || null,
      },
    };
  }

  /**
   * Handle webhook
   */
  async handleWebhook(webhookData: any, signature?: string) {
    // Get webhook secret from settings
    const settingsQuery = `SELECT setting_value FROM settings WHERE setting_key = 'pinpayments_webhook_secret'`;
    const settingsResult = await this.dataSource.query(settingsQuery);
    const webhookSecret = settingsResult[0]?.setting_value || '';

    // Verify webhook signature (simplified - implement proper verification)
    // PinPayments webhook verification would go here

    const eventType = webhookData.type;
    const chargeData = webhookData.data;

    // Record webhook event in payment history
    if (chargeData?.token) {
      const existingPayment = await this.getPaymentByTransactionId(chargeData.token);

      if (existingPayment) {
        const newStatus = eventType.includes('succeeded') ? 'succeeded' :
          eventType.includes('failed') ? 'failed' :
            eventType.includes('refund') ? 'refunded' : 'pending';

        await this.updatePaymentStatus(
          chargeData.token,
          newStatus,
          webhookData,
          eventType.includes('failed') ? webhookData : undefined
        );
      }
    }

    // Find order by transaction ID
    const orderResult = await this.dataSource.query(
      'SELECT order_id, payment_response FROM orders WHERE payment_transaction_id = $1',
      [chargeData.token]
    );

    if (orderResult.length > 0) {
      const orderByTransaction = orderResult[0];

      if (eventType === 'charge.succeeded') {
        await this.dataSource.query(
          `UPDATE orders 
           SET payment_status = 'succeeded',
               payment_response = $1,
               payment_date = CURRENT_TIMESTAMP,
               order_status = 3
           WHERE payment_transaction_id = $2`,
          [JSON.stringify(AdminPaymentsService.sanitizePaymentResponse(webhookData)), chargeData.token]
        );
      } else if (eventType === 'charge.failed') {
        await this.dataSource.query(
          `UPDATE orders 
           SET payment_status = 'failed',
               payment_response = $1
           WHERE payment_transaction_id = $2`,
          [JSON.stringify(AdminPaymentsService.sanitizePaymentResponse(webhookData)), chargeData.token]
        );
      } else if (eventType === 'refund.succeeded') {
        const currentResponse = orderByTransaction.payment_response || {};
        await this.dataSource.query(
          `UPDATE orders 
           SET payment_status = 'refunded',
               payment_response = jsonb_set(
                 COALESCE(payment_response, '{}'::jsonb),
                 '{refund}',
                 $1::jsonb
               )
           WHERE payment_transaction_id = $2`,
          [JSON.stringify(AdminPaymentsService.sanitizePaymentResponse(chargeData)), chargeData.token]
        );
      }
    }

    return { received: true };
  }
}
