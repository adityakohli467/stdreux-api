import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import * as crypto from "crypto";
import { StripeService } from "../../common/services/stripe.service";
import { EmailService } from "../../common/services/email.service";
import { NotificationService } from "../../common/services/notification.service";
import { InvoiceService } from "../../common/services/invoice.service";
import { ConfigService } from "@nestjs/config";
import { AdminXeroService } from "../admin-xero/admin-xero.service";

@Injectable()
export class StorePaymentService {
  private readonly logger = new Logger(StorePaymentService.name);

  constructor(
    private dataSource: DataSource,
    private stripeService: StripeService,
    private emailService: EmailService,
    private notificationService: NotificationService,
    private invoiceService: InvoiceService,
    private configService: ConfigService,
    private xeroService: AdminXeroService,
  ) { }

  /**
   * Create Stripe Payment Intent
   * POST /store/payment/create-intent
   */
  async createPaymentIntent(
    data: { order_id: number },
    ipAddress?: string,
    userAgent?: string,
  ) {
    const { order_id } = data;

    if (!order_id) {
      throw new BadRequestException("Order ID is required");
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Get order details with customer information
      const orderQuery = `
        SELECT 
          o.order_id,
          o.order_total,
          o.order_status,
          o.payment_status,
          o.customer_id,
          o.delivery_fee,
          c.email as customer_email,
          c.firstname,
          c.lastname,
          c.telephone as customer_phone
        FROM orders o
        LEFT JOIN customer c ON o.customer_id = c.customer_id
        WHERE o.order_id = $1
      `;
      const orderResult = await queryRunner.query(orderQuery, [order_id]);
      const order = orderResult[0];

      if (!order) {
        throw new NotFoundException("Order not found");
      }

      // Check if already paid
      if (
        order.order_status === 2 ||
        order.payment_status === "paid" ||
        order.payment_status === "succeeded"
      ) {
        throw new BadRequestException({
          message: "Order already paid",
          order_id: order.order_id,
        });
      }

      // Calculate total amount (convert to cents for Stripe)
      const totalAmount = parseFloat(order.order_total || 0);
      const totalAmountCents = Math.round(totalAmount * 100);

      if (totalAmountCents <= 0) {
        throw new BadRequestException("Order total must be greater than zero");
      }

      // Generate idempotency key
      const idempotencyKey = `order_${order_id}_${Date.now()}`;
      const requestId = crypto.randomUUID();

      // Create Stripe Payment Intent
      const paymentIntent = await this.stripeService.createPaymentIntent({
        amount: totalAmountCents,
        currency: "aud",
        orderId: order.order_id.toString(),
        customerEmail: order.customer_email || "",
        customerName:
          `${order.firstname || ""} ${order.lastname || ""}`.trim() ||
          undefined,
        customerPhone: order.customer_phone || undefined,
        description: `Order #${order.order_id}`,
        metadata: {
          order_id: order.order_id.toString(),
          customer_id: order.customer_id?.toString() || "",
          delivery_fee: order.delivery_fee?.toString() || "0",
          ip_address: ipAddress || "",
          user_agent: userAgent || "",
          request_id: requestId,
          idempotency_key: idempotencyKey,
        },
      });

      await queryRunner.commitTransaction();

      this.logger.log(
        `[Stripe] Created payment intent for order ${order_id}: ${paymentIntent.paymentIntentId}`,
      );

      return {
        success: true,
        client_secret: paymentIntent.clientSecret,
        payment_intent_id: paymentIntent.paymentIntentId,
        order_id: order.order_id,
        amount: totalAmount,
        currency: "AUD",
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Create Stripe Payment Intent for a cart before order creation
   * POST /store/payment/create-intent-for-cart
   */
  async createPaymentIntentForCart(
    data: {
      amount: number;
      email?: string;
      firstname?: string;
      lastname?: string;
      telephone?: string;
    },
    userId: number | null,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const { amount, email, firstname, lastname, telephone } = data;

    if (!amount || amount <= 0) {
      throw new BadRequestException(
        "Amount is required and must be greater than zero",
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      let customer;

      if (userId) {
        // Get customer details from user ID
        const customerQuery = `
          SELECT 
            c.customer_id,
            c.email as customer_email,
            c.firstname,
            c.lastname,
            c.telephone as customer_phone
          FROM customer c
          WHERE c.user_id = $1
        `;
        const customerResult = await queryRunner.query(customerQuery, [userId]);
        customer = customerResult[0];

        if (!customer) {
          throw new NotFoundException("Customer not found");
        }
      } else {
        // Guest flow
        if (!email) {
          throw new BadRequestException("Email is required for guest payment intent");
        }

        // Check if a registered account exists for this email in either the "user" table OR linked in "customer" table
        const searchEmail = email.trim().toLowerCase();
        
        const userAccount = await queryRunner.query(
          'SELECT user_id, email, username FROM "user" WHERE LOWER(TRIM(email)) = $1 LIMIT 1',
          [searchEmail]
        );

        if (userAccount.length > 0) {
          throw new BadRequestException("This email is already associated with a registered account. Please log in to complete your purchase.");
        }

        const linkedCustomer = await queryRunner.query(
          'SELECT customer_id FROM customer WHERE LOWER(TRIM(email)) = $1 AND user_id IS NOT NULL LIMIT 1',
          [searchEmail]
        );
        if (linkedCustomer.length > 0) {
          throw new BadRequestException("This email is already associated with a registered account. Please log in to complete your purchase.");
        }


        const guestCustomerQuery = `
          SELECT c.customer_id, c.telephone as customer_phone, c.email as customer_email, c.firstname, c.lastname, c.user_id
          FROM customer c 
          WHERE LOWER(TRIM(c.email)) = $1 AND c.user_id IS NULL
          LIMIT 1
        `;
        const guestCustomerResult = await queryRunner.query(guestCustomerQuery, [searchEmail]);
        customer = guestCustomerResult[0];

        if (!customer) {
          // Create a new guest customer entry if doesn't exist
          const insertCustomerQuery = `
            INSERT INTO customer (firstname, lastname, email, telephone, customer_type, status, created_from, approved, customer_date_added)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            RETURNING customer_id, telephone as customer_phone, email as customer_email, firstname, lastname
          `;
          const insertResult = await queryRunner.query(insertCustomerQuery, [
            (firstname || 'Guest').trim(),
            (lastname || 'User').trim(),
            email.trim().toLowerCase(),
            telephone ? telephone.trim() : null,
            'Retail',
            1, // status: active
            'guest',
            true // approved: guests are auto-approved for their cart session
          ]);
          customer = insertResult[0];
        }
      }

      // Calculate total amount (convert to cents for Stripe)
      const totalAmountCents = Math.round(amount * 100);

      // Create Stripe Payment Intent
      const paymentIntent = await this.stripeService.createPaymentIntent({
        amount: totalAmountCents,
        currency: "aud",
        orderId: "cart_pending", // Placeholder since order not created yet
        customerEmail: customer.customer_email || "",
        customerName:
          `${customer.firstname || ""} ${customer.lastname || ""}`.trim() ||
          undefined,
        customerPhone: customer.customer_phone || undefined,
        description: `St Dreux Cart Payment`,
        metadata: {
          customer_id: customer.customer_id?.toString() || "",
          type: "cart_payment",
          email: customer.customer_email || "",
          ip_address: ipAddress || "",
          user_agent: userAgent || "",
        },
      });

      await queryRunner.commitTransaction();

      this.logger.log(
        `[Stripe] Created cart payment intent for ${userId ? 'user ' + userId : 'guest ' + customer.customer_email}: ${paymentIntent.paymentIntentId}`,
      );

      return {
        success: true,
        client_secret: paymentIntent.clientSecret,
        payment_intent_id: paymentIntent.paymentIntentId,
        amount: amount,
        currency: "AUD",
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Cancel a stale Payment Intent
   * POST /store/payment/cancel-intent
   */
  async cancelPaymentIntent(paymentIntentId: string) {
    if (!paymentIntentId) {
      throw new BadRequestException("Payment Intent ID is required");
    }

    const result = await this.stripeService.cancelPaymentIntent(paymentIntentId);
    return { success: result.success, status: result.status };
  }

  /**
   * Verify Stripe payment after client-side confirmation
   * POST /store/payment/verify
   */
  async verifyPayment(data: { payment_intent_id: string; order_id?: number }) {
    const { payment_intent_id } = data;
    let { order_id } = data;

    if (!payment_intent_id) {
      throw new BadRequestException("Payment Intent ID is required");
    }

    // Retrieve payment intent status from Stripe
    const paymentIntent =
      await this.stripeService.getPaymentIntentStatus(payment_intent_id);

    // If no order_id provided, try to find it from payment_history
    if (!order_id) {
      const phQuery = await this.dataSource.query(
        `SELECT order_id FROM payment_history WHERE payment_transaction_id = $1 AND order_id IS NOT NULL`,
        [payment_intent_id],
      );
      if (phQuery.length > 0 && phQuery[0].order_id) {
        order_id = phQuery[0].order_id;
        this.logger.log(`[Stripe] Found order_id ${order_id} from payment_history for verify of ${payment_intent_id}`);
      }
    }

    // Check if order exists and matches
    if (order_id) {
      const orderQuery = await this.dataSource.query(
        `SELECT o.order_id, o.order_status, o.payment_status, ph.payment_status as history_status 
         FROM orders o
         LEFT JOIN payment_history ph ON ph.payment_transaction_id = $2
         WHERE o.order_id = $1`,
        [order_id, payment_intent_id],
      );

      if (orderQuery.length === 0) {
        throw new NotFoundException("Order not found");
      }

      const order = orderQuery[0];

      // If payment succeeded, ensure order AND payment history are marked as paid
      if (paymentIntent.status === "succeeded" && (order.order_status !== 2 || order.history_status !== 'succeeded')) {
        await this.handlePaymentSucceeded({
          id: payment_intent_id,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          metadata: paymentIntent.metadata,
          status: paymentIntent.status,
          order_id: order_id
        });
      }
    } else if (paymentIntent.status === "succeeded") {
      // No order linked, but payment succeeded - use success handler to create/update record
      await this.handlePaymentSucceeded({
        id: payment_intent_id,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        metadata: paymentIntent.metadata,
        status: paymentIntent.status
      });
    }

    return {
      success: paymentIntent.status === "succeeded",
      payment_intent: {
        payment_intent_id: paymentIntent.paymentIntentId,
        status: paymentIntent.status,
        amount: paymentIntent.amount / 100, // Convert from cents
        currency: paymentIntent.currency,
        order_id: paymentIntent.orderId,
      },
    };
  }

  /**
   * Handle Stripe webhooks
   * POST /store/payment/stripe/webhook
   */
  async handleStripeWebhook(
    event: any,
    signature: string,
    rawBody: string | Buffer,
  ) {
    // Get webhook secret from settings
    const settingsQuery = await this.dataSource.query(
      `SELECT setting_value FROM settings WHERE setting_key = 'stripe_webhook_secret'`,
    );
    const webhookSecret =
      settingsQuery[0]?.setting_value ||
      this.configService.get<string>("STRIPE_WEBHOOK_SECRET");

    if (!webhookSecret) {
      this.logger.error("[Stripe] Webhook secret not configured");
      throw new InternalServerErrorException("Webhook secret not configured");
    }

    if (!signature) {
      this.logger.error("[Stripe] Missing webhook signature");
      throw new BadRequestException("Missing signature");
    }

    // Verify webhook signature
    let stripeEvent;
    try {
      stripeEvent = this.stripeService.verifyWebhookSignature(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch (error: any) {
      this.logger.error("[Stripe] Invalid webhook signature:", error.message);
      throw new BadRequestException("Invalid signature");
    }

    // Log webhook event
    this.logger.log(`[Stripe] Webhook received: ${stripeEvent.type}`);

    // Handle different event types
    switch (stripeEvent.type) {
      case "payment_intent.succeeded":
        await this.handlePaymentSucceeded(stripeEvent.data.object);
        break;

      case "payment_intent.payment_failed":
        await this.handlePaymentFailed(stripeEvent.data.object);
        break;

      case "payment_intent.canceled":
        await this.handlePaymentCanceled(stripeEvent.data.object);
        break;

      case "charge.refunded":
        await this.handleRefundSucceeded(stripeEvent.data.object);
        break;

      default:
        this.logger.log(`[Stripe] Unhandled event type: ${stripeEvent.type}`);
    }

    return { received: true };
  }

  /**
   * Handle payment succeeded webhook
   */
  private async handlePaymentSucceeded(paymentData: any) {
    const paymentIntentId = paymentData.id || paymentData.payment_intent_id;
    // Prefer numeric order_id if available (check both top-level and metadata)
    let orderId = paymentData.order_id;
    if (!orderId || isNaN(parseInt(orderId.toString()))) {
      orderId = paymentData.metadata?.order_id;
    }

    if (!paymentIntentId) {
      this.logger.error("[Stripe] Missing payment_intent_id in payment succeeded event");
      return;
    }

    // Validate orderId is a real numeric ID (not "cart_pending" or other placeholder)
    const strOrderId = orderId ? orderId.toString() : "";
    const parsedOrderId = (strOrderId && !isNaN(parseInt(strOrderId))) ? parseInt(strOrderId) : NaN;
    
    if (isNaN(parsedOrderId) || parsedOrderId <= 0) {
      orderId = null; // Treat non-numeric order IDs as missing
      if (strOrderId && strOrderId !== "cart_pending") {
        this.logger.log(`[Stripe] order_id "${strOrderId}" is not a valid numeric ID, will check payment_history for intent ${paymentIntentId}`);
      }
    } else {
      orderId = parsedOrderId;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Get payment history record to find order_id if missing from metadata
      const paymentHistoryQuery = await queryRunner.query(
        `SELECT payment_history_id, payment_status, amount, order_id FROM payment_history 
         WHERE payment_transaction_id = $1`,
        [paymentIntentId],
      );

      let paymentHistory = paymentHistoryQuery[0];
      
      // Fallback to order_id from database if not in metadata
      if (!orderId && paymentHistory?.order_id) {
        orderId = paymentHistory.order_id;
        this.logger.log(`[Stripe] Found order_id ${orderId} in payment_history for intent ${paymentIntentId}`);
      }

      // Create payment history record if it doesn't exist (deferred creation)
      if (!paymentHistory) {
        this.logger.log(`[Stripe] Creating deferred payment history for ${paymentIntentId}`);
        const metadata = paymentData.metadata || {};
        const amount = paymentData.amount ? (paymentData.amount / 100) : 0;
        const customer_id = metadata.customer_id ? parseInt(metadata.customer_id) : null;
        const customer_email = metadata.customer_email || metadata.email || paymentData.receipt_email || null;
        const payment_type = metadata.type === "cart_payment" ? "cart_payment" : "payment_intent";
        
        const insertResult = await queryRunner.query(
          `INSERT INTO payment_history (
            order_id, 
            payment_transaction_id, 
            payment_type, 
            payment_status,
            payment_gateway, 
            amount, 
            currency, 
            customer_id,
            customer_email,
            gateway_response, 
            idempotency_key,
            ip_address,
            user_agent,
            request_id,
            metadata,
            created_at,
            processed_at,
            updated_at,
            card_last4,
            card_brand,
            payment_method
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $16, $17, $18)
          RETURNING *`,
          [
            orderId || null,
            paymentIntentId,
            payment_type,
            "succeeded",
            "stripe",
            amount,
            (paymentData.currency || "AUD").toUpperCase(),
            customer_id,
            customer_email,
            JSON.stringify({
              ...paymentData,
              completed_at: new Date().toISOString(),
              webhook_received: true,
            }),
            metadata.idempotency_key || null,
            metadata.ip_address || null,
            metadata.user_agent || null,
            metadata.request_id || null,
            JSON.stringify(metadata),
            paymentData.charges?.data?.[0]?.payment_method_details?.card?.last4 || null,
            paymentData.charges?.data?.[0]?.payment_method_details?.card?.brand || null,
            paymentData.charges?.data?.[0]?.payment_method_details?.type || "card",
          ]
        );
        paymentHistory = insertResult[0];

        // Log audit event for creation
        await queryRunner.query(
          `INSERT INTO payment_audit_log (
            payment_history_id,
            order_id,
            transaction_id,
            event_type,
            new_status,
            event_data,
            performed_by,
            ip_address,
            user_agent
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            paymentHistory.payment_history_id,
            orderId || null,
            paymentIntentId,
            "created",
            "succeeded",
            JSON.stringify({
              action: "payment_recorded_success",
              gateway: "stripe",
              amount: amount,
              currency: (paymentData.currency || "AUD").toUpperCase(),
            }),
            "webhook",
            metadata.ip_address || null,
            metadata.user_agent || null,
          ],
        );
      }

      if (!orderId) {
        // No order linked yet (cart payment where order hasn't been created).
        await queryRunner.commitTransaction();
        return;
      }

      this.logger.log(
        `[Stripe] Payment succeeded: ${paymentIntentId} for order ${orderId}`,
      );

      const oldStatus = paymentHistory?.payment_status || "pending";
      
      // Safety check if orderId is still missing but we are here
      if (!orderId) {
          await queryRunner.commitTransaction();
          return;
      }


      // Update order status to paid
      await queryRunner.query(
        `UPDATE orders 
         SET order_status = 2,
             payment_status = 'succeeded',
             payment_date = CURRENT_TIMESTAMP,
             payment_gateway = 'stripe',
             payment_response = $1,
             date_modified = CURRENT_TIMESTAMP
         WHERE order_id = $2`,
        [JSON.stringify(paymentData), parseInt(orderId.toString())],
      );

      // Update payment history
      if (paymentHistory) {
        await queryRunner.query(
          `UPDATE payment_history 
           SET payment_status = 'succeeded',
               gateway_response = jsonb_set(
                 COALESCE(gateway_response, '{}'::jsonb),
                 '{payment_completed}',
                 $1::jsonb
               ),
               processed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP,
               card_last4 = COALESCE($2, card_last4),
               card_brand = COALESCE($3, card_brand),
               payment_method = COALESCE($4, payment_method),
               order_id = COALESCE(order_id, $6)
           WHERE payment_transaction_id = $5`,
          [
            JSON.stringify({
              ...paymentData,
              completed_at: new Date().toISOString(),
              webhook_received: true,
            }),
            paymentData.charges?.data?.[0]?.payment_method_details?.card
              ?.last4 || null,
            paymentData.charges?.data?.[0]?.payment_method_details?.card
              ?.brand || null,
            paymentData.charges?.data?.[0]?.payment_method_details?.type ||
            "card",
            paymentIntentId,
            orderId ? parseInt(orderId.toString()) : null,
          ],
        );

        // Log audit event
        await queryRunner.query(
          `INSERT INTO payment_audit_log (
            payment_history_id,
            order_id,
            transaction_id,
            event_type,
            old_status,
            new_status,
            event_data,
            performed_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            paymentHistory.payment_history_id,
            parseInt(orderId.toString()),
            paymentIntentId,
            "status_changed",
            oldStatus,
            "succeeded",
            JSON.stringify({
              action: "payment_succeeded",
              gateway: "stripe",
              amount: paymentHistory.amount,
              webhook_data: paymentData,
            }),
            "webhook",
          ],
        );
      }

      await queryRunner.commitTransaction();
      this.logger.log(`[Stripe] Order ${orderId} marked as paid`);

      // Payment-received email disabled per request. The order confirmation email is unaffected.
      /*
      try {
        const orderQuery = await this.dataSource.query(
          `SELECT 
            o.order_id,
            o.customer_order_name,
            o.customer_order_email,
            c.email,
            c.firstname,
            c.lastname,
            o.order_total,
            o.accounts_email
          FROM orders o
          LEFT JOIN customer c ON o.customer_id = c.customer_id
          WHERE o.order_id = $1`,
          [parseInt(orderId.toString())],
        );

        if (orderQuery.length > 0) {
          const order = orderQuery[0];
          const customerName =
            order.customer_order_name ||
            `${order.firstname || ""} ${order.lastname || ""}`.trim() ||
            "Customer";

          const toEmail = order.customer_order_email || order.email;
          const managerEmail = order.accounts_email || null;
          const emailList = managerEmail
            ? [toEmail, managerEmail].filter(Boolean)
            : [toEmail].filter(Boolean);

          if (emailList.length > 0) {
            const orderTotal = parseFloat(order.order_total || 0);
            const amountPaidRaw = paymentHistory?.amount ?? orderTotal;
            const amountPaid =
              typeof amountPaidRaw === "number"
                ? amountPaidRaw
                : parseFloat(amountPaidRaw || 0);

            let pdfBuffer: Buffer | null = null;
            try {
              pdfBuffer = await this.invoiceService.getInvoicePDF(
                parseInt(order.order_id),
              );
            } catch (invoiceError) {
              this.logger.error(
                "Failed to generate invoice PDF for payment email:",
                invoiceError,
              );
            }

            const companyName = this.configService.get<string>("COMPANY_NAME") || "St Dreux Coffee";
            const contactNumber = this.configService.get<string>("COMPANY_PHONE") || "";
            const contactEmail = this.configService.get<string>("COMPANY_EMAIL") || "";
            // const frontendUrl = this.configService.get<string>("FRONTEND_URL") || "https://stdreux.com.au";
            const frontendUrl = this.configService.get<string>("FRONTEND_URL") || "https://portal.stdreux.com.au";
            const invoiceUrl = `${frontendUrl}/orders/${order.order_id}/invoice`;
            const formattedAmount = `$${(isNaN(amountPaid) ? 0 : amountPaid).toFixed(2)}`;

            await this.notificationService.sendNotification({
              templateKey: "order_payment_received",
              recipientEmail: emailList,
              recipientName: customerName,
              variables: {
                customer_name: customerName,
                order_number: String(order.order_id),
                invoice_number: String(order.order_id),
                amount_paid: formattedAmount,
                company_name: companyName,
                contact_number: contactNumber,
                contact_email: contactEmail,
              },
              customSubject: `Payment Received – Order #${order.order_id} – ${companyName}`,
              customBody: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; }
    .header { background-color: #2952E6; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>${companyName}</h1></div>
    <div class="content">
      <p>Dear ${customerName},</p>
      <p>Thank you for your payment.</p>
      <p>This email confirms that payment has been successfully received for your order.</p>
      <p>
        Order number: ${order.order_id}<br/>
        Invoice number: ${order.order_id}<br/>
        Payment amount: ${formattedAmount}
      </p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${invoiceUrl}" style="display: inline-block; padding: 12px 24px; background-color: #28a745; color: #ffffff !important; text-decoration: none; border-radius: 5px; margin: 10px 5px;"><span style="color: #ffffff !important;">View Invoice</span></a>
      </div>
      <p>If you have any questions, please contact us at ${contactNumber} or ${contactEmail}.</p>
      <p>Kind regards,<br/>${companyName} Team</p>
    </div>
  </div>
</body>
</html>`,
              attachments: undefined, // Removed separate invoice attachment as requested
            });
          }
        }
      } catch (emailError) {
        this.logger.error(
          "Failed to send payment confirmation email:",
          emailError,
        );
      }
      */

      // Create invoice in Xero for the paid order
      try {
        const xeroStatus = await this.xeroService.isConnected();
        if (xeroStatus.connected) {
          await this.xeroService.markInvoiceAsPaidForOrder(parseInt(orderId.toString()));
          this.logger.log(`[Xero] Order ${orderId} marked as paid in Xero`);
        } else {
          this.logger.warn(`[Xero] Not connected — skipping auto-sync for order ${orderId}`);
        }
      } catch (xeroError) {
        this.logger.error(`[Xero] Failed to create invoice for order ${orderId}:`, xeroError);
        // Don't fail the payment flow if Xero fails
      }
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[Stripe] Error handling payment succeeded:`, error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Handle payment failed webhook
   */
  private async handlePaymentFailed(paymentData: any) {
    const paymentIntentId = paymentData.id || paymentData.payment_intent_id;
    const orderId = paymentData.metadata?.order_id;

    if (!paymentIntentId) {
      this.logger.error(
        "[Stripe] Missing payment_intent_id in payment failed event",
      );
      return;
    }

    this.logger.log(
      `[Stripe] Payment failed: ${paymentIntentId} for order ${orderId || "unknown"}`,
    );

    // Get payment history record
    const paymentHistoryQuery = await this.dataSource.query(
      `SELECT payment_history_id, payment_status FROM payment_history 
       WHERE payment_transaction_id = $1`,
      [paymentIntentId],
    );

    const paymentHistory = paymentHistoryQuery[0];
    const oldStatus = paymentHistory?.payment_status || "pending";

    // Update payment history
    await this.dataSource.query(
      `UPDATE payment_history 
       SET payment_status = 'failed',
           gateway_error = $1,
           gateway_response = jsonb_set(
             COALESCE(gateway_response, '{}'::jsonb),
             '{payment_failed}',
             $2::jsonb
           ),
           processed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE payment_transaction_id = $3`,
      [
        JSON.stringify({
          ...paymentData,
          failed_at: new Date().toISOString(),
          error_code: paymentData.last_payment_error?.code,
          error_message: paymentData.last_payment_error?.message,
        }),
        JSON.stringify({
          ...paymentData,
          failed_at: new Date().toISOString(),
          webhook_received: true,
        }),
        paymentIntentId,
      ],
    );

    // Optionally update order status
    if (orderId) {
      await this.dataSource.query(
        `UPDATE orders 
         SET payment_status = 'failed',
             payment_response = $1,
             date_modified = CURRENT_TIMESTAMP
         WHERE order_id = $2`,
        [JSON.stringify(paymentData), parseInt(orderId.toString())],
      );
    }

    // Log audit event
    if (paymentHistory) {
      await this.dataSource.query(
        `INSERT INTO payment_audit_log (
          payment_history_id,
          order_id,
          transaction_id,
          event_type,
          old_status,
          new_status,
          event_data,
          performed_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          paymentHistory.payment_history_id,
          orderId ? parseInt(orderId.toString()) : null,
          paymentIntentId,
          "error",
          oldStatus,
          "failed",
          JSON.stringify({
            action: "payment_failed",
            gateway: "stripe",
            error: paymentData.last_payment_error?.message,
            error_code: paymentData.last_payment_error?.code,
            webhook_data: paymentData,
          }),
          "webhook",
        ],
      );
    }

    // Send payment failure email to customer
    if (orderId) {
      try {
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
          [parseInt(orderId.toString())],
        );

        if (orderQuery.length > 0) {
          const order = orderQuery[0];
          const customerName =
            order.customer_order_name ||
            `${order.firstname || ""} ${order.lastname || ""}`.trim() ||
            "Customer";
          const customerEmail = order.customer_order_email || order.email;
          const orderTotal = parseFloat(order.order_total || 0);
          const companyName =
            this.configService.get<string>("COMPANY_NAME") || "Sendrix";
          const frontendUrl =
            this.configService.get<string>("FRONTEND_URL") ||
            this.configService.get<string>("STORE_URL") ||
            "http://localhost:3000";
          const paymentLink = `${frontendUrl}/payment?order_id=${orderId}`;

          const errorMessage =
            paymentData.last_payment_error?.message ||
            "Payment could not be processed";
          const errorCode = paymentData.last_payment_error?.code || "unknown";

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
    .header { background-color: #dc3545; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
    .error-box { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
    .cta-button { display: inline-block; padding: 15px 30px; background-color: #0d6efd; color: #ffffff !important; text-decoration: none; border-radius: 5px; margin: 20px 0; font-size: 16px; font-weight: bold; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Payment Failed - Order #${orderId}</h1>
    </div>
    <div class="content">
      <p>Dear ${customerName},</p>
      <p>We were unable to process your payment for order #${orderId}.</p>
      
      <div class="error-box">
        <strong>Payment Error:</strong> ${errorMessage}
        ${errorCode !== "unknown" ? `<br/><small>Error Code: ${errorCode}</small>` : ""}
      </div>

      <p><strong>Order Total:</strong> $${orderTotal.toFixed(2)}</p>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${paymentLink}" class="cta-button" style="color: #ffffff !important; text-decoration: none; display: inline-block;">
          <span style="color: #ffffff !important; text-decoration: none;">Try Payment Again</span>
        </a>
      </div>

      <p><strong>Common reasons for payment failure:</strong></p>
      <ul>
        <li>Insufficient funds</li>
        <li>Card expired or invalid</li>
        <li>Incorrect card details</li>
        <li>Bank declined the transaction</li>
      </ul>

      <p>Please try again with a different payment method or contact your bank if the issue persists.</p>
      
      <p>If you continue to experience issues, please contact our support team for assistance.</p>
      
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
              subject: `Payment Failed - Order #${orderId} - ${companyName}`,
              html: emailHtml,
            });

            this.logger.log(
              `Payment failure email sent to ${customerEmail} for order #${orderId}`,
            );
          }
        }
      } catch (emailError) {
        this.logger.error("Failed to send payment failure email:", emailError);
        // Don't fail the webhook if email fails
      }
    }
  }

  /**
   * Handle payment canceled webhook
   */
  private async handlePaymentCanceled(paymentData: any) {
    const paymentIntentId = paymentData.id || paymentData.payment_intent_id;

    if (!paymentIntentId) {
      this.logger.error(
        "[Stripe] Missing payment_intent_id in payment canceled event",
      );
      return;
    }

    this.logger.log(`[Stripe] Payment canceled: ${paymentIntentId}`);

    // Update payment history
    await this.dataSource.query(
      `UPDATE payment_history 
       SET payment_status = 'canceled',
           gateway_response = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE payment_transaction_id = $2`,
      [JSON.stringify(paymentData), paymentIntentId],
    );
  }

  /**
   * Handle refund succeeded webhook
   */
  private async handleRefundSucceeded(refundData: any) {
    const refundId = refundData.id;
    const paymentIntentId = refundData.payment_intent;
    const refundAmount = parseFloat(refundData.amount || 0) / 100; // Convert from cents

    if (!refundId || !paymentIntentId) {
      this.logger.error(
        "[Stripe] Missing refund_id or payment_intent_id in refund succeeded event",
      );
      return;
    }

    this.logger.log(
      `[Stripe] Refund succeeded: ${refundId} for payment intent ${paymentIntentId}`,
    );

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Get payment history record
      const paymentHistoryQuery = await queryRunner.query(
        `SELECT payment_history_id, order_id, payment_status, refund_amount, amount 
         FROM payment_history 
         WHERE payment_transaction_id = $1`,
        [paymentIntentId],
      );

      const paymentHistory = paymentHistoryQuery[0];
      if (!paymentHistory) {
        this.logger.error(
          `[Stripe] Payment history not found for payment intent ${paymentIntentId}`,
        );
        return;
      }

      const newRefundAmount =
        parseFloat(paymentHistory.refund_amount || 0) + refundAmount;
      const newStatus =
        newRefundAmount >= parseFloat(paymentHistory.amount || 0)
          ? "refunded"
          : paymentHistory.payment_status;

      // Update payment history
      await queryRunner.query(
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
          JSON.stringify([
            {
              refund_id: refundId,
              amount: refundAmount,
              refunded_at: new Date().toISOString(),
              ...refundData,
            },
          ]),
          paymentIntentId,
        ],
      );

      // Update order status if fully refunded
      if (newStatus === "refunded" && paymentHistory.order_id) {
        await queryRunner.query(
          `UPDATE orders 
           SET payment_status = 'refunded',
               payment_response = jsonb_set(
                 COALESCE(payment_response, '{}'::jsonb),
                 '{refund}',
                 $1::jsonb
               ),
               date_modified = CURRENT_TIMESTAMP
           WHERE order_id = $2`,
          [JSON.stringify(refundData), paymentHistory.order_id],
        );
      }

      // Log audit event
      await queryRunner.query(
        `INSERT INTO payment_audit_log (
          payment_history_id,
          order_id,
          transaction_id,
          event_type,
          old_status,
          new_status,
          event_data,
          performed_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          paymentHistory.payment_history_id,
          paymentHistory.order_id,
          paymentIntentId,
          "refunded",
          paymentHistory.payment_status,
          newStatus,
          JSON.stringify({
            action: "refund_succeeded",
            gateway: "stripe",
            refund_id: refundId,
            refund_amount: refundAmount,
            total_refunded: newRefundAmount,
            original_amount: paymentHistory.amount,
            webhook_data: refundData,
          }),
          "webhook",
        ],
      );

      await queryRunner.commitTransaction();

      // Send refund confirmation email
      if (paymentHistory.order_id) {
        try {
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
              `${order.firstname || ""} ${order.lastname || ""}`.trim() ||
              "Customer";
            const customerEmail = order.customer_order_email || order.email;
            const isFullRefund =
              newRefundAmount >= parseFloat(paymentHistory.amount || 0);
            const companyName =
              this.configService.get<string>("COMPANY_NAME") || "Sendrix";

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
        <p><strong>Refund Type:</strong> ${isFullRefund ? "Full Refund" : "Partial Refund"}</p>
        <p><strong>Refund ID:</strong> ${refundId}</p>
      </div>

      <p>The refund has been processed and should appear in your account within 5-10 business days, depending on your bank or card issuer.</p>

      ${isFullRefund ? "<p><strong>Note:</strong> This is a full refund. Your order has been cancelled.</p>" : ""}

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

              this.logger.log(
                `Refund confirmation email sent to ${customerEmail} for order #${order.order_id}`,
              );
            }
          }
        } catch (emailError) {
          this.logger.error(
            "Failed to send refund confirmation email:",
            emailError,
          );
          // Don't fail the webhook if email fails
        }
      }
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[Stripe] Error handling refund succeeded:`, error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
