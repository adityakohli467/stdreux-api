import { Injectable, Logger, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AdminNotificationsService } from '../admin-notifications/admin-notifications.service';
import { EmailService } from '../../common/services/email.service';
import { NotificationService } from '../../common/services/notification.service';
import { PricingService } from '../../common/services/pricing.service';
import { StripeService } from '../../common/services/stripe.service';
import { InvoiceService } from '../../common/services/invoice.service';
import { StorePaymentService } from '../store-payment/store-payment.service';
import * as crypto from 'crypto';

@Injectable()
export class StoreOrdersService {
  private readonly logger = new Logger(StoreOrdersService.name);

  constructor(
    private dataSource: DataSource,
    private notificationsService: AdminNotificationsService,
    private emailService: EmailService,
    private notificationService: NotificationService,
    private configService: ConfigService,
    private pricingService: PricingService,
    private stripeService: StripeService,
    private invoiceService: InvoiceService,
    private storePaymentService: StorePaymentService,
  ) { }

  private normalizeTime(input: string): string {
    if (!input) return '00:00:00';
    const t = input.trim().toUpperCase();
    let m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/);
    if (!m) m = t.match(/^(\d{1,2})(\d{2})(\d{2})?\s*(AM|PM)?$/);
    if (m) {
      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const sec = m[3] ? parseInt(m[3], 10) : 0;
      const ap = m[4];
      if (ap === 'PM' && h < 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      const hh = String(h).padStart(2, '0');
      const mm = String(min).padStart(2, '0');
      const ss = String(sec).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    }
    return '00:00:00';
  }
  /**
   * Create order (checkout)
   */
  async createOrder(
    userId: number | null,
    orderData: {
      items: any[];
      delivery_address: string;
      delivery_date_time?: string;
      delivery_date?: string;
      delivery_start_date?: string;
      next_delivery_date?: string;
      delivery_time?: string;
      delivery_fee?: number;
      payment_method?: string;
      payment_intent_id?: string;
      notes?: string;
      coupon_code?: string;
      postcode?: string;
      wholesale_discount_percentage?: number;
      standing_order?: number; // Subscription frequency in days (7=weekly, 14=fortnightly, 0=none)
      firstname?: string;
      lastname?: string;
      email?: string;
      telephone?: string;
    },
  ) {
    const {
      items,
      delivery_address,
      delivery_date_time,
      delivery_date,
      delivery_start_date,
      next_delivery_date,
      delivery_time,
      delivery_fee = 0,
      payment_method,
      payment_intent_id,
      notes,
      coupon_code,
      postcode,
      standing_order = 0,
      firstname,
      lastname,
      email,
      telephone,
    } = orderData;

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('Order items are required');
    }

    if (!delivery_address) {
      throw new BadRequestException('Delivery address is required');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      let customer;

      if (userId) {
        // Get customer with customer_type and pay_later status
        const customerQuery = `
          SELECT c.customer_id, c.telephone, c.email, c.customer_type, COALESCE(c.pay_later, false) as pay_later
          FROM customer c 
          WHERE c.user_id = $1
        `;
        const customerResult = await queryRunner.query(customerQuery, [userId]);
        customer = customerResult[0];

        if (!customer) {
          throw new NotFoundException('Customer not found');
        }
      } else {
        // Guest flow
        if (!email) {
          throw new BadRequestException('Email is required for guest orders');
        }

        // Check if a registered account exists for this email in either the "user" table OR linked in "customer" table
        const searchEmail = email.trim().toLowerCase();
        const userAccount = await queryRunner.query(
          'SELECT user_id FROM "user" WHERE LOWER(TRIM(email)) = $1 LIMIT 1',
          [searchEmail]
        );

        if (userAccount.length > 0) {
          this.logger.warn(`Blocked guest checkout attempt with registered email: ${email}`);
          throw new BadRequestException("This email is already associated with a registered account. Please log in to your account to complete your purchase.");
        }

        const linkedCustomer = await queryRunner.query(
          'SELECT customer_id FROM customer WHERE LOWER(TRIM(email)) = $1 AND user_id IS NOT NULL LIMIT 1',
          [searchEmail]
        );
        if (linkedCustomer.length > 0) {
          this.logger.warn(`Blocked guest checkout attempt with email linked to customer user_id: ${email}`);
          throw new BadRequestException("This email is already associated with a registered account. Please log in to your account to complete your purchase.");
        }

        const customerQuery = `
          SELECT c.customer_id, c.telephone, c.email, c.customer_type, c.user_id, COALESCE(c.pay_later, false) as pay_later
          FROM customer c 
          WHERE LOWER(TRIM(c.email)) = $1
          LIMIT 1
        `;
        const customerResult = await queryRunner.query(customerQuery, [searchEmail]);
        customer = customerResult[0];

        if (!customer) {
          // Create a new guest customer entry if doesn't exist
          const insertCustomerQuery = `
            INSERT INTO customer (firstname, lastname, email, telephone, customer_type, status, created_from, approved, customer_date_added)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            RETURNING customer_id, telephone, email, customer_type
          `;
          const insertResult = await queryRunner.query(insertCustomerQuery, [
            (firstname || 'Guest').trim(),
            (lastname || 'User').trim(),
            email.trim().toLowerCase(),
            telephone ? telephone.trim() : null,
            'Retail',
            1, // status: active
            'guest',
            true // approved: guests are auto-approved for their specific order
          ]);
          customer = insertResult[0];
          customer.pay_later = false;
        }
      }

      // Determine if wholesale
      const { isWholesale } = await this.pricingService.getCustomerType(customer.customer_id);

      // Get customer discounts
      const { productDiscounts: productDiscountsMap, optionDiscounts: optionDiscountsMap } =
        await this.pricingService.getCustomerDiscounts(customer.customer_id);

      // Calculate order total with product-option-level and product-level discounts
      let subtotal = 0;
      const orderItems: any[] = [];

      for (const item of items) {
        const productQuery = `
          SELECT product_id, product_name, product_price, retail_price, retail_discount_percentage, user_price
          FROM product 
          WHERE product_id = $1 AND product_status = 1
        `;
        const productResult = await queryRunner.query(productQuery, [item.product_id]);
        const product = productResult[0];

        if (!product) {
          throw new NotFoundException(`Product ${item.product_id} not found`);
        }

        const retailPrice = parseFloat(product.product_price || 0);
        const wholesalePrice = product.retail_price ? parseFloat(product.retail_price || 0) : null;
        const retailDiscountPercentage = product.retail_discount_percentage ? parseFloat(product.retail_discount_percentage) : null;

        // Prioritize price from payload, then DB user_price
        let userPrice = item.price ? parseFloat(item.price) : null;
        if (userPrice === null || isNaN(userPrice) || userPrice <= 0) {
          userPrice = product.user_price ? parseFloat(product.user_price) : null;
        }

        const productDiscount = productDiscountsMap.get(product.product_id) || 0;

        const pricing = this.pricingService.calculateProductPrice(
          retailPrice,
          wholesalePrice,
          retailDiscountPercentage,
          isWholesale,
          productDiscount,
          userPrice
        );

        // Calculate item total using the calculated price
        let itemTotal = pricing.finalPrice * item.quantity;

        // Check if product has options
        const hasOptions = item.options && item.options.length > 0;

        if (hasOptions) {
          // Product has options - option price is per-unit, multiply by product quantity
          let optionBasedTotal = 0;
          let hasNonZeroOptionPrices = false;

          for (const option of item.options) {
            if (option.option_value_id) {
              const discountKey = `${product.product_id}_${option.option_value_id}`;
              const optionDiscount = optionDiscountsMap.get(discountKey) || 0;

              const baseOptionPrice = parseFloat(option.option_price || option.price || 0);

              const optionPricing = this.pricingService.calculateOptionPrice(
                null, // standardPrice (unknown without lookup)
                null, // wholesalePrice (unknown without lookup)
                baseOptionPrice,
                isWholesale,
                optionDiscount
              );

              if (optionPricing.finalPrice > 0) {
                hasNonZeroOptionPrices = true;
              }

              // Use product-level quantity (option price is per-unit)
              // Set option.quantity to item.quantity so it's stored correctly in order_product_option
              option.quantity = item.quantity;
              optionBasedTotal += optionPricing.finalPrice * item.quantity;

              // Update option price in the item object for storage
              option.price = optionPricing.finalPrice;
              option.option_price = optionPricing.finalPrice;
            }
          }

          // Only override itemTotal if options have actual prices
          // (handles edge case where option price was absorbed into product base price)
          if (hasNonZeroOptionPrices) {
            itemTotal = optionBasedTotal;
          }
        }

        subtotal += itemTotal;

        orderItems.push({
          product_id: product.product_id,
          product_name: product.product_name,
          quantity: item.quantity,
          price: pricing.finalPrice, // Store the calculated final price
          total: itemTotal,
          options: item.options || [],
        });
      }

      let wholesaleDiscount = 0;
      const wp = typeof orderData.wholesale_discount_percentage === 'number'
        ? parseFloat(orderData.wholesale_discount_percentage.toString())
        : 0;
      if (!isNaN(wp) && wp > 0) {
        wholesaleDiscount = subtotal * (wp / 100);
      }

      const afterWholesaleDiscount = subtotal - wholesaleDiscount;

      // Apply coupon if provided (after wholesale discount)
      let couponDiscount = 0;
      let couponId = null;

      if (coupon_code) {
        // Trim whitespace and make case-insensitive lookup
        const normalizedCouponCode = (coupon_code || '').trim().toUpperCase();
        const couponQuery = `
          SELECT * FROM coupon 
          WHERE UPPER(TRIM(coupon_code)) = $1 AND status = 1
        `;
        const couponResult = await queryRunner.query(couponQuery, [normalizedCouponCode]);
        const coupon = couponResult[0];

        if (coupon) {
          couponId = coupon.coupon_id;
          // Apply coupon discount after wholesale discount
          if (coupon.type === 'P') {
            couponDiscount = afterWholesaleDiscount * (parseFloat(coupon.coupon_discount) / 100);
          } else if (coupon.type === 'F') {
            couponDiscount = parseFloat(coupon.coupon_discount);
          }
          couponDiscount = Math.min(couponDiscount, afterWholesaleDiscount);
        }
      }

      // Apply discounts
      const afterDiscount = afterWholesaleDiscount - couponDiscount;

      // Calculate GST and total
      // For wholesale customers, GST is exclusive (added to total)
      // For retail customers, GST is inclusive (not added to total)
      const deliveryFee = parseFloat((delivery_fee || 0).toString());
      const gst = isWholesale ? Math.round((afterDiscount + deliveryFee) * 0.1 * 100) / 100 : 0;
      const total = afterDiscount + gst + deliveryFee;

      // Parse delivery date and time (support direct delivery_date_time or separate date/time)
      let deliveryDateTime = new Date();
      const directDateTime = (delivery_date_time && delivery_date_time.trim()) || '';
      const preferredDate =
        (next_delivery_date && next_delivery_date.trim()) ||
        (delivery_start_date && delivery_start_date.trim()) ||
        (delivery_date && delivery_date.trim()) ||
        '';
      if (directDateTime) {
        const normalized = directDateTime.includes('T') ? directDateTime : directDateTime.replace(' ', 'T');
        deliveryDateTime = new Date(normalized);
      } else if (preferredDate) {
        const hasTimePart = preferredDate.includes('T') || preferredDate.includes(':');
        if (hasTimePart) {
          deliveryDateTime = new Date(preferredDate);
        } else if (delivery_time) {
          const time = delivery_time.trim();
          const normalizedTime = this.normalizeTime(time);
          const iso = `${preferredDate}T${normalizedTime}`;
          deliveryDateTime = new Date(iso);
        } else {
          const defaultDeliveryTime = this.configService.get<string>('DEFAULT_DELIVERY_TIME') || '00:00:00';
          const safeDefaultTime = /^\d{2}:\d{2}:\d{2}$/.test(defaultDeliveryTime) ? defaultDeliveryTime : '00:00:00';
          deliveryDateTime = new Date(`${preferredDate}T${safeDefaultTime}`);
        }
      }

      // Validate pay_later method if used
      if (payment_method === 'pay_later' && !customer.pay_later) {
        throw new BadRequestException('Pay Later is not enabled for your account');
      }

      // Check payment intent status if provided
      let finalPaymentStatus = payment_method === 'pay_later' ? 'pay_later' : 'pending';
      let finalOrderStatus = 1; // 1 = New

      if (payment_intent_id && payment_method !== 'pay_later') {
        try {
          const piStatus = await this.stripeService.getPaymentIntentStatus(payment_intent_id);
          if (piStatus.status === 'succeeded') {
            finalPaymentStatus = 'succeeded';
            finalOrderStatus = 2; // 2 = Paid
          }
        } catch (e) {
          this.logger.warn(`Failed to verify payment intent ${payment_intent_id}: ${e.message}`);
        }
      }

      // Create order
      // Get default location_id (first active location, typically Sydney)
      let defaultLocationId: number | null = null;
      try {
        const locationResult = await queryRunner.query(
          `SELECT location_id FROM locations WHERE location_status = 1 ORDER BY location_id ASC LIMIT 1`
        );
        if (locationResult.length > 0) {
          defaultLocationId = locationResult[0].location_id;
        }
      } catch (e) {
        // locations table may not exist or has different schema
      }

      const orderQuery = `
        INSERT INTO orders (
          customer_id,
          branch_id,
          shipping_method,
          order_total,
          order_status,
          delivery_date_time,
          delivery_fee,
          delivery_address,
          delivery_phone,
          delivery_email,
          postcode,
          order_comments,
          pickup_delivery_notes,
          user_id,
          coupon_id,
          coupon_discount,
          standing_order,
          customer_from,
          payment_method,
          payment_status,
          payment_transaction_id,
          location_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        RETURNING order_id
      `;

      const orderResult = await queryRunner.query(orderQuery, [
        customer.customer_id,
        1, // branch_id
        1, // shipping_method
        total,
        finalOrderStatus,
        deliveryDateTime,
        deliveryFee,
        delivery_address,
        customer.telephone || (telephone || null),
        customer.email || (email || null),
        parseInt((postcode || '3000').toString()) || 3000,
        (notes && notes.trim()) || null,
        (notes && notes.trim()) || null,
        userId || null,
        couponId,
        couponDiscount, // Store coupon discount for historical accuracy
        standing_order || 0, // Subscription frequency (0 = not a subscription)
        'portal',
        payment_method || 'stripe',
        finalPaymentStatus,
        payment_intent_id || null,
        defaultLocationId, // Assign default location (Sydney) for frontend orders
      ]);

      const orderId = orderResult[0].order_id;

      // Add order products
      for (let i = 0; i < orderItems.length; i++) {
        const item = orderItems[i];
        const orderProductQuery = `
          INSERT INTO order_product (
            order_id,
            product_id,
            quantity,
            price,
            total,
            sort_order
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING order_product_id
        `;

        const opResult = await queryRunner.query(orderProductQuery, [
          orderId,
          item.product_id,
          item.quantity,
          item.price,
          item.total,
          i + 1,
        ]);

        const orderProductId = opResult[0].order_product_id;

        // Add order product options
        if (item.options && item.options.length > 0) {
          for (const option of item.options) {
            let productOptionId = option.product_option_id || option.option_id;
            if (!productOptionId && option.option_value_id) {
              const poQuery = await queryRunner.query(
                `SELECT product_option_id FROM product_option 
                 WHERE product_id = $1 AND option_value_id = $2 
                 LIMIT 1`,
                [item.product_id, option.option_value_id],
              );
              if (poQuery.length > 0) {
                productOptionId = poQuery[0].product_option_id;
              }
            }

            if (!productOptionId) {
              productOptionId = 0;
            }

            const optionQuantity = option.quantity || item.quantity;
            const optionPrice = parseFloat((option.price || option.option_price || 0).toString());
            const optionTotal = optionPrice * optionQuantity;

            const optionQuery = `
              INSERT INTO order_product_option (
                order_id,
                order_product_id,
                product_option_id,
                option_name,
                option_value,
                option_quantity,
                option_price,
                option_total
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `;

            await queryRunner.query(optionQuery, [
              orderId,
              orderProductId,
              productOptionId,
              option.option_name || '',
              option.option_value || '',
              optionQuantity,
              optionPrice,
              optionTotal,
            ]);
          }
        }

        // Stock management not implemented - product table doesn't have product_quantity column
        // TODO: Add stock management if needed in the future
      }

      // Update coupon usage if applicable
      if (couponId) {
        // Check if uses_total column exists, create it if not
        const columnCheck = await queryRunner.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'coupon' AND column_name = 'uses_total'
        `);

        if (columnCheck.length === 0) {
          // Add the uses_total column if it doesn't exist
          await queryRunner.query(`
            ALTER TABLE coupon ADD COLUMN IF NOT EXISTS uses_total INT DEFAULT 0
          `);
        }

        const updateCouponQuery = `
          UPDATE coupon
          SET uses_total = COALESCE(uses_total, 0) + 1
          WHERE coupon_id = $1
        `;
        await queryRunner.query(updateCouponQuery, [couponId]);
      }

      // Update payment history with creating order_id and sync status if applicable
      if (payment_intent_id) {
        await queryRunner.query(
          `UPDATE payment_history SET order_id = $1 WHERE payment_transaction_id = $2`,
          [orderId, payment_intent_id]
        );

        // If payment already succeeded (checked above), also update payment_history status
        // This handles the case where the webhook fired before the order was created
        // and couldn't update because order_id was "cart_pending"
        if (finalPaymentStatus === 'succeeded') {
          await queryRunner.query(
            `UPDATE payment_history 
             SET payment_status = 'succeeded',
                 processed_at = COALESCE(processed_at, CURRENT_TIMESTAMP),
                 updated_at = CURRENT_TIMESTAMP
             WHERE payment_transaction_id = $1 AND payment_status != 'succeeded'`,
            [payment_intent_id]
          );
        }
      }
      await queryRunner.commitTransaction();

      // Explicitly verify payment if payment_intent_id is provided
      // This handles email sending, invoice generation, and ensures full sync.
      // Now properly awaited so failures are logged.
      if (payment_intent_id) {
        try {
          await this.storePaymentService.verifyPayment({
            payment_intent_id,
            order_id: orderId,
          });
        } catch (err) {
          this.logger.error(`Error during payment verification for order ${orderId}:`, err);
        }
      }

      // Get complete order details
      const completeOrderQuery = `
        SELECT 
          o.*,
          c.firstname,
          c.lastname,
          c.email,
          c.telephone
        FROM orders o
        JOIN customer c ON o.customer_id = c.customer_id
        WHERE o.order_id = $1
      `;
      const completeOrder = await this.dataSource.query(completeOrderQuery, [orderId]);

      // Create notification for admin users
      if (this.notificationsService) {
        const customerName = completeOrder[0].customer_order_name ||
          `${completeOrder[0].firstname || ''} ${completeOrder[0].lastname || ''}`.trim() ||
          'Customer';

        this.notificationsService.createNotification({
          type: 'order',
          message: `New order #${orderId} placed by ${customerName} for $${total.toFixed(2)}`,
          order_id: orderId,
          metadata: {
            order_total: total,
            customer_name: customerName,
            delivery_date: preferredDate || delivery_date,
            delivery_time: delivery_time,
          },
        }).catch((err) => {
          this.logger.error('Failed to create order notification', err);
        });
      }

      // Send order confirmation email to customer
      try {
        const order = completeOrder[0];
        const customerEmail = order.customer_order_email || order.email;
        const customerName = order.customer_order_name ||
          `${order.firstname || ''} ${order.lastname || ''}`.trim() ||
          'Customer';

        const companyName = this.configService.get<string>('COMPANY_NAME') || 'Sendrix';
        const customerType = (customer?.customer_type || '').toString().toLowerCase();
        const isWholesalePremium = Boolean(isWholesale) && customerType.includes('premium');
        const isWholesaleEssential = Boolean(isWholesale) && customerType.includes('essential');

        const backendUrl = this.configService.get<string>('BACKEND_URL') ||
          this.configService.get<string>('FRONTEND_URL') ||
          'http://localhost:9000';
        const frontendUrl = this.configService.get<string>('FRONTEND_URL') ||
          this.configService.get<string>('STORE_URL') ||
          'http://localhost:3000';

        const paymentLink = `${frontendUrl}/payment?order_id=${orderId}`;
        const orderTotal = parseFloat(order.order_total || total);
        const invoiceUrl = `${frontendUrl}/orders/${orderId}/invoice`;
        const displayDate = preferredDate || (order.delivery_date_time ? new Date(order.delivery_date_time).toISOString() : '');

        const contactNumber = this.configService.get<string>('COMPANY_PHONE') || '';
        const contactEmail = this.configService.get<string>('COMPANY_EMAIL') || '';

        // Determine if it's a wholesale/retailer order without payment
        const isNoPayment = order.payment_status === 'pending' || order.payment_status === 'pay_later';
        const isRetailer = customerType.includes('retailer');
        const isSubscription = Boolean(order.standing_order && Number(order.standing_order) > 0);

        if (customerEmail) {
          if ((isWholesalePremium || isWholesaleEssential || isRetailer) && isNoPayment) {
            const orderDateRaw = order.date_added || order.date_modified || new Date().toISOString();
            const orderDate = new Date(orderDateRaw).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: '2-digit' });

            let templateKey = 'wholesale_premium_order_received';
            if (isRetailer) {
              templateKey = 'retailer_order_received';
            } else if (isWholesaleEssential) {
              templateKey = 'wholesale_essential_order_received';
            }

            await this.notificationService.sendNotification({
              templateKey: templateKey,
              recipientEmail: customerEmail,
              recipientName: customerName,
              variables: {
                customer_name: customerName,
                order_number: String(orderId),
                order_date: orderDate,
                company_name: companyName,
                contact_number: contactNumber,
                contact_email: contactEmail,
              },
            });

            this.logger.log(`${isRetailer ? 'Retailer' : 'Wholesale'} order received email sent to ${customerEmail} for order #${orderId}`);
          } else {
            const customerSubject = isSubscription 
              ? `Subscription Confirmation #${orderId} - ${companyName}`
              : `Order Confirmation #${orderId} - ${companyName}`;
            const customerHeader = isSubscription
              ? `Subscription Started #${orderId}`
              : `Order Confirmation #${orderId}`;
            const customerMainText = isSubscription
              ? `Thank you for starting a subscription! We've received your subscription order and it's being processed.`
              : `Thank you for your order! We've received your order and it's being processed.`;

            const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 0 auto; background-color: #fff; padding: 20px; }
    .header { background-color: #0d6efd; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
    .order-details { background-color: #f9f9f9; padding: 15px; margin: 15px 0; border-radius: 5px; }
    .order-info { margin: 10px 0; }
    .order-info strong { display: inline-block; width: 150px; }
    .cta-button { display: inline-block; padding: 12px 24px; background-color: #0d6efd; color: #ffffff !important; text-decoration: none; border-radius: 5px; margin: 10px 5px; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${customerHeader}</h1>
    </div>
    <div class="content">
      <p>Dear ${customerName},</p>
      <p>${customerMainText}</p>
      
      <div class="order-details">
        <h3>Order Details</h3>
        <div class="order-info"><strong>Order Number:</strong> #${orderId}</div>
        <div class="order-info"><strong>Order Date:</strong> ${new Date().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: '2-digit' })}</div>
        <div class="order-info"><strong>Order Total:</strong> $${(total - gst).toFixed(2)}</div>
        ${order.delivery_address ? `<div class="order-info"><strong>Delivery Address:</strong> ${order.delivery_address}</div>` : ''}
      </div>

      <div style="text-align: center; margin: 30px 0;">
        ${(order.payment_status !== 'succeeded' && order.order_status !== 2) ? `<a href="${paymentLink}" class="cta-button" style="color: #ffffff !important;"><span style="color: #ffffff !important;">Pay Now</span></a>` : ''}
        <a href="${invoiceUrl}" class="cta-button" style="background-color: #28a745; color: #ffffff !important;"><span style="color: #ffffff !important;">View Invoice</span></a>
      </div>

      ${(order.payment_status !== 'succeeded' && order.order_status !== 2) ? `<p>You can pay for your order by clicking the "Pay Now" button above. Once payment is received, we'll process your order.</p>` : ''}
      
      <p>If you have any questions about your order, please don't hesitate to contact us.</p>
      
      <p>Thank you for choosing ${companyName}!</p>
    </div>
    <div class="footer">
      <p>If you have any questions, please contact us.</p>
      <p>&copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
          `;

            const customerEmailResult = await this.notificationService.sendNotification({
              templateKey: 'order_confirmation',
              recipientEmail: customerEmail,
              customSubject: customerSubject,
              customBody: emailHtml,
            });

            if (!customerEmailResult.success) {
              this.logger.error(`Failed to send order confirmation email to ${customerEmail}: ${customerEmailResult.error}`);
            } else {
              this.logger.log(`Order confirmation email sent to ${customerEmail} for order #${orderId}`);
            }
          }
        }          // Send admin notification email
          const adminEmail = this.configService.get<string>('ADMIN_EMAIL') || this.configService.get<string>('FROM_EMAIL') || 'info@stdreux.com.au';

          // Build product rows for the email
          const productRowsHtml = orderItems.map((item: any) => {
            const optionsText = item.options && item.options.length > 0
              ? item.options.map((o: any) => `${o.option_name || ''}: ${o.option_value || ''}`).join(', ')
              : '';
            return `
              <tr>
                <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${item.product_name || 'Product'}${optionsText ? `<br><small style="color: #666;">${optionsText}</small>` : ''}</td>
                <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
                <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: right;">$${(item.total || 0).toFixed(2)}</td>
              </tr>`;
          }).join('');

          const adminEmailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 0 auto; background-color: #fff; padding: 20px; }
    .header { background-color: #0d6efd; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
    .order-details { background-color: #f9f9f9; padding: 15px; margin: 15px 0; border-radius: 5px; }
    .order-info { margin: 10px 0; }
    .order-info strong { display: inline-block; width: 150px; }
    .customer-details { background-color: #e7f3ff; padding: 15px; margin: 15px 0; border-radius: 5px; }
    .cta-button { display: inline-block; padding: 12px 24px; background-color: #0d6efd; color: #ffffff !important; text-decoration: none; border-radius: 5px; margin: 10px 5px; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🛒 ${isSubscription ? 'New Subscription' : 'New Order'} Received!</h1>
      <h2>${isSubscription ? 'Subscription' : 'Order'} #${orderId}</h2>
    </div>
    <div class="content">
      <p>You have recieved a new ${isSubscription ? 'subscription ' : ''}order from ${customerName}.</p>
      <p>Please find the invoice details attached to this email.</p>

      <div class="customer-details">
        <h3>Customer Information</h3>
        <div class="order-info"><strong>Customer Name:</strong> ${customerName}</div>
        <div class="order-info"><strong>Email:</strong> ${customerEmail}</div>
        ${order.phone ? `<div class="order-info"><strong>Phone:</strong> ${order.phone}</div>` : ''}
      </div>

      <div class="order-details">
        <h3>Order Summary</h3>
        <div class="order-info"><strong>Order Number:</strong> #${orderId}</div>
        <div class="order-info"><strong>Order Date:</strong> ${new Date().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: '2-digit' })}</div>
        <div class="order-info"><strong>Order Total:</strong> $${total.toFixed(2)}</div>
        <div class="order-info"><strong>Subtotal:</strong> $${subtotal.toFixed(2)}</div>
        ${wholesaleDiscount > 0 ? `<div class="order-info"><strong>Wholesale Discount:</strong> -$${wholesaleDiscount.toFixed(2)}</div>` : ''}
        ${couponDiscount > 0 ? `<div class="order-info"><strong>Coupon Discount:</strong> -$${couponDiscount.toFixed(2)}</div>` : ''}
        <div class="order-info"><strong>GST:</strong> $${gst.toFixed(2)}</div>
        <div class="order-info"><strong>Delivery Fee:</strong> $${deliveryFee.toFixed(2)}</div>
        ${delivery_time ? `<div class="order-info"><strong>Delivery Time:</strong> ${delivery_time}</div>` : ''}
        ${order.delivery_address ? `<div class="order-info"><strong>Delivery Address:</strong> ${order.delivery_address}</div>` : ''}
      </div>

      <div class="order-details">
        <h3>Products Ordered</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background-color: #f0f0f0;">
              <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #ddd;">Product</th>
              <th style="padding: 8px 12px; text-align: center; border-bottom: 2px solid #ddd;">Qty</th>
              <th style="padding: 8px 12px; text-align: right; border-bottom: 2px solid #ddd;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${productRowsHtml}
          </tbody>
        </table>
      </div>

      <p style="color: #666; font-size: 12px; margin-top: 30px;">This is an automated notification from your e-commerce system.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
          `;

          let pdfBuffer: Buffer | null = null;
          try {
            pdfBuffer = await this.invoiceService.generatePDFBuffer(orderId);
          } catch (pdfErr) {
            this.logger.error(`Failed to generate PDF for order #${orderId}`, pdfErr);
          }

          const attachments = undefined; // Removed separate invoice attachment as requested

          const adminEmailResult = await this.notificationService.sendNotification({
            templateKey: 'admin_new_order',
            recipientEmail: adminEmail,
            customSubject: `🛒 ${isSubscription ? 'New Subscription' : 'New Order'} #${orderId} - $${total.toFixed(2)} from ${customerName}`,
            customBody: adminEmailHtml,
            attachments,
          });

          if (!adminEmailResult.success) {
            this.logger.error(`Failed to send Admin notification email to ${adminEmail} for order #${orderId}: ${adminEmailResult.error}`);
          } else {
            this.logger.log(`Admin notification email sent to ${adminEmail} for order #${orderId}`);
          }
      } catch (emailError) {
        this.logger.error('Failed to send order confirmation email:', emailError);
        // Don't fail the order creation if email fails
      }

      // Get coupon code if coupon was applied
      let couponCode = null;
      if (couponId) {
        const couponCodeQuery = `SELECT coupon_code FROM coupon WHERE coupon_id = $1`;
        const couponCodeResult = await this.dataSource.query(couponCodeQuery, [couponId]);
        couponCode = couponCodeResult[0]?.coupon_code || null;
      }

      return {
        message: 'Order placed successfully',
        order: {
          ...completeOrder[0],
          items: orderItems,
          delivery_time: delivery_time || (delivery_date_time ? (delivery_date_time.split('T')[1]?.slice(0, 5)) : null),
          subtotal,
          wholesale_discount: wholesaleDiscount,
          coupon_discount: couponDiscount,
          coupon_code: couponCode,
          total_discount: wholesaleDiscount + couponDiscount,
          after_wholesale_discount: afterWholesaleDiscount,
          after_discount: afterDiscount,
          gst,
          delivery_fee: deliveryFee,
          total,
        },
        order_id: orderId,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get customer orders
   */
  async listOrders(userId: number, page: number = 1, limit: number = 10) {
    const offset = (Number(page) - 1) * Number(limit);

    // Get customer
    const customerQuery = `SELECT customer_id FROM customer WHERE user_id = $1`;
    const customerResult = await this.dataSource.query(customerQuery, [userId]);
    const customer = customerResult[0];

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    // Get orders
    const ordersQuery = `
      SELECT 
        o.order_id,
        o.order_total as total,
        o.order_status,
        o.date_added,
        o.delivery_date_time,
        o.delivery_address,
        o.delivery_fee,
        COALESCE(COUNT(op.order_product_id), 0)::integer as item_count
      FROM orders o
      LEFT JOIN order_product op ON o.order_id = op.order_id
      WHERE o.customer_id = $1
      GROUP BY o.order_id, o.order_total, o.order_status, o.date_added, o.delivery_date_time, o.delivery_address, o.delivery_fee
      ORDER BY o.date_added DESC
      LIMIT $2 OFFSET $3
    `;

    const ordersResult = await this.dataSource.query(ordersQuery, [
      customer.customer_id,
      Number(limit),
      offset,
    ]);

    // Get total count
    const countQuery = `
      SELECT COUNT(*)::integer as total 
      FROM orders 
      WHERE customer_id = $1
    `;
    const countResult = await this.dataSource.query(countQuery, [customer.customer_id]);
    const total = parseInt(countResult[0]?.total || '0', 10);

    const orders = (ordersResult || []).map((order: any) => {
      const totalVal = parseFloat(order.total || '0');
      const deliveryFeeVal = parseFloat(order.delivery_fee || '0');
      const taxablePortion = totalVal - deliveryFeeVal;
      const gstVal = taxablePortion - (taxablePortion / 1.1);
      return {
        ...order,
        status_name: order.order_status === 5 ? 'Completed' : (order.order_status === 1 ? 'New' : (order.order_status === 2 ? 'Paid' : (order.order_status === 4 ? 'Awaiting Approval' : (order.order_status === 7 ? 'Approved' : 'Updated')))),
        gst: gstVal.toFixed(4),
      };
    });

    return {
      orders,
      pagination: {
        page: Number(page) || 1,
        limit: Number(limit) || 10,
        total: total || 0,
        total_pages: Math.ceil((total || 0) / (Number(limit) || 10)),
      },
    };
  }

  /**
   * Get order details for public view (payment link / invoice from email)
   * No user authentication required - used for admin-sent payment links
   */
  async getOrderPublicView(orderId: number) {
    // Get order with coupon info
    const orderQuery = `
      SELECT 
        o.*,
        cp.coupon_code,
        cp.type as coupon_type
      FROM orders o
      LEFT JOIN coupon cp ON o.coupon_id = cp.coupon_id
      WHERE o.order_id = $1
    `;

    const orderResult = await this.dataSource.query(orderQuery, [orderId]);
    const order = orderResult[0];

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // Get order products with product names
    const productsQuery = `
      SELECT 
        op.*,
        p.product_name,
        p.product_image
      FROM order_product op
      LEFT JOIN product p ON op.product_id = p.product_id
      WHERE op.order_id = $1
      ORDER BY op.sort_order, op.order_product_id
    `;
    const productsResult = await this.dataSource.query(productsQuery, [orderId]);

    // Get order product options for each product
    const items: any[] = [];
    let subtotal = 0;

    for (const product of productsResult) {
      const optionsQuery = `
        SELECT * FROM order_product_option 
        WHERE order_product_id = $1
      `;
      const optionsResult = await this.dataSource.query(optionsQuery, [product.order_product_id]);

      const productBaseTotal = parseFloat(product.total) || 0;

      // Calculate options total (same logic as invoice service)
      let optionsTotal = 0;
      optionsResult.forEach((opt: any) => {
        optionsTotal += (parseFloat(opt.option_price) || 0) * (parseInt(opt.option_quantity) || 1);
      });

      // Check for double counting
      const isDoubleCount = productBaseTotal > 0 && Math.abs(productBaseTotal - optionsTotal) < 0.01;
      const itemTotal = isDoubleCount ? productBaseTotal : (productBaseTotal + optionsTotal);
      subtotal += itemTotal;

      items.push({
        product_id: product.product_id,
        product_name: product.product_name || 'Unknown Product',
        quantity: parseInt(product.quantity || '1', 10),
        price: parseFloat(product.price || '0'),
        total: itemTotal,
        product_image: product.product_image,
        options: optionsResult.map((opt: any) => ({
          option_name: opt.option_name,
          option_value: opt.option_value,
          option_quantity: parseInt(opt.option_quantity) || 1,
          option_price: parseFloat(opt.option_price) || 0,
          option_total: parseFloat(opt.option_total) || ((parseFloat(opt.option_price) || 0) * (parseInt(opt.option_quantity) || 1)),
        })),
      });
    }

    // Calculate breakdown
    const deliveryFee = parseFloat(order.delivery_fee || '0');
    let wholesaleDiscount = 0;
    const afterWholesaleDiscount = subtotal - wholesaleDiscount;

    let couponDiscount = 0;
    let couponCode = order.coupon_code || null;

    if (order.coupon_id) {
      if (order.coupon_discount && parseFloat(order.coupon_discount) > 0) {
        couponDiscount = parseFloat(order.coupon_discount);
      } else if (order.coupon_type) {
        const couponQuery = `SELECT coupon_discount FROM coupon WHERE coupon_id = $1`;
        const couponResult = await this.dataSource.query(couponQuery, [order.coupon_id]);
        if (couponResult[0]) {
          if (order.coupon_type === 'P') {
            couponDiscount = afterWholesaleDiscount * (parseFloat(couponResult[0].coupon_discount) / 100);
          } else {
            couponDiscount = parseFloat(couponResult[0].coupon_discount);
          }
          couponDiscount = Math.min(couponDiscount, afterWholesaleDiscount);
        }
      }
    }

    const afterDiscount = afterWholesaleDiscount - couponDiscount;
    const gst = 0;
    const calculatedTotal = Math.round((afterDiscount + gst + deliveryFee) * 100) / 100;

    return {
      order: {
        order_id: order.order_id,
        order_total: order.order_total,
        order_status: order.order_status,
        payment_status: order.payment_status,
        delivery_address: order.delivery_address,
        delivery_phone: order.delivery_phone,
        delivery_email: order.delivery_email,
        firstname: order.firstname,
        lastname: order.lastname,
        date_added: order.date_added,
        delivery_date: order.delivery_date,
        delivery_time: order.delivery_time,
        delivery_fee: deliveryFee.toFixed(2),
        status_name: order.order_status === 5 ? 'Completed' : (order.order_status === 1 ? 'New' : (order.order_status === 2 ? 'Paid' : (order.order_status === 4 ? 'Awaiting Approval' : (order.order_status === 7 ? 'Approved' : 'Updated')))),
        items,
        subtotal: subtotal.toFixed(2),
        wholesale_discount: wholesaleDiscount.toFixed(2),
        coupon_discount: couponDiscount.toFixed(2),
        coupon_code: couponCode,
        after_wholesale_discount: afterWholesaleDiscount.toFixed(2),
        after_discount: afterDiscount.toFixed(2),
        gst: gst.toFixed(2),
        total: calculatedTotal.toFixed(2),
        calculated_total: calculatedTotal.toFixed(2),
      },
    };
  }

  /**
   * Get single order details
   */
  async getOrder(userId: number, orderId: number) {
    // Get customer with customer_type
    const customerQuery = `
      SELECT c.customer_id, c.customer_type 
      FROM customer c 
      WHERE c.user_id = $1
    `;
    const customerResult = await this.dataSource.query(customerQuery, [userId]);
    const customer = customerResult[0];

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    // Get order with coupon info
    const orderQuery = `
      SELECT 
        o.*,
        cp.coupon_code,
        cp.type as coupon_type
      FROM orders o
      LEFT JOIN coupon cp ON o.coupon_id = cp.coupon_id
      WHERE o.order_id = $1 AND o.customer_id = $2
    `;

    const orderResult = await this.dataSource.query(orderQuery, [orderId, customer.customer_id]);
    const order = orderResult[0];

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // Get order products with product names
    const productsQuery = `
      SELECT 
        op.*,
        p.product_name,
        p.product_image
      FROM order_product op
      LEFT JOIN product p ON op.product_id = p.product_id
      WHERE op.order_id = $1
      ORDER BY op.sort_order, op.order_product_id
    `;
    const productsResult = await this.dataSource.query(productsQuery, [orderId]);

    // Get order product options for each product
    const items: any[] = [];
    let subtotal = 0;

    for (const product of productsResult) {
      const optionsQuery = `
        SELECT * FROM order_product_option 
        WHERE order_product_id = $1
      `;
      const optionsResult = await this.dataSource.query(optionsQuery, [product.order_product_id]);

      // Calculate item total including option prices (matching invoice service logic)
      const productBaseTotal = parseFloat(product.total) || 0;

      let optionsTotal = 0;
      optionsResult.forEach((opt: any) => {
        optionsTotal += (parseFloat(opt.option_price) || 0) * (parseInt(opt.option_quantity) || 1);
      });

      // Check for double counting
      const isDoubleCount = productBaseTotal > 0 && Math.abs(productBaseTotal - optionsTotal) < 0.01;
      const itemTotal = isDoubleCount ? productBaseTotal : (productBaseTotal + optionsTotal);
      subtotal += itemTotal;

      items.push({
        product_id: product.product_id,
        product_name: product.product_name || 'Unknown Product',
        quantity: parseInt(product.quantity || '1', 10),
        price: parseFloat(product.price || '0'),
        total: itemTotal,
        product_image: product.product_image,
        options: optionsResult.map((opt: any) => ({
          option_name: opt.option_name,
          option_value: opt.option_value,
          option_quantity: parseInt(opt.option_quantity) || 1,
          option_price: parseFloat(opt.option_price) || 0,
          option_total: parseFloat(opt.option_total) || ((parseFloat(opt.option_price) || 0) * (parseInt(opt.option_quantity) || 1)),
        })),
      });
    }

    // Calculate breakdown
    const orderTotal = parseFloat(order.order_total || '0');
    const deliveryFee = parseFloat(order.delivery_fee || '0');

    let wholesaleDiscount = 0;

    const afterWholesaleDiscount = subtotal - wholesaleDiscount;

    // Get coupon discount (use stored value if available, otherwise calculate)
    let couponDiscount = 0;
    let couponCode = order.coupon_code || null;

    if (order.coupon_id) {
      // Use stored coupon_discount if available (for historical accuracy)
      if (order.coupon_discount && parseFloat(order.coupon_discount) > 0) {
        couponDiscount = parseFloat(order.coupon_discount);
      } else if (order.coupon_type) {
        // Calculate from coupon type if stored discount not available
        const couponQuery = `SELECT coupon_discount FROM coupon WHERE coupon_id = $1`;
        const couponResult = await this.dataSource.query(couponQuery, [order.coupon_id]);
        if (couponResult[0]) {
          if (order.coupon_type === 'P') {
            couponDiscount = afterWholesaleDiscount * (parseFloat(couponResult[0].coupon_discount) / 100);
          } else {
            couponDiscount = parseFloat(couponResult[0].coupon_discount);
          }
          couponDiscount = Math.min(couponDiscount, afterWholesaleDiscount);
        }
      }
    }

    const afterDiscount = afterWholesaleDiscount - couponDiscount;
    // For wholesale customers, GST is exclusive (added to total)
    // For retail customers, GST is inclusive (not added to total)
    const customerTypeStr = customer.customer_type || '';
    const isWholesaleOrder = customerTypeStr.includes('Wholesale') || customerTypeStr.includes('Wholesaler');
    const gst = isWholesaleOrder ? Math.round((afterDiscount + deliveryFee) * 0.1 * 100) / 100 : 0;
    const calculatedTotal = Math.round((afterDiscount + gst + deliveryFee) * 100) / 100;

    return {
      order: {
        ...order,
        status_name: order.order_status === 5 ? 'Completed' : (order.order_status === 1 ? 'New' : (order.order_status === 2 ? 'Paid' : (order.order_status === 4 ? 'Awaiting Approval' : (order.order_status === 7 ? 'Approved' : 'Updated')))),
        items,
        subtotal: subtotal.toFixed(2),
        wholesale_discount: wholesaleDiscount.toFixed(2),
        coupon_discount: couponDiscount.toFixed(2),
        coupon_code: couponCode,
        after_wholesale_discount: afterWholesaleDiscount.toFixed(2),
        after_discount: afterDiscount.toFixed(2),
        gst: gst.toFixed(2),
        delivery_fee: deliveryFee.toFixed(2),
        total: calculatedTotal.toFixed(2),
        calculated_total: calculatedTotal.toFixed(2),
      },
    };
  }
}
