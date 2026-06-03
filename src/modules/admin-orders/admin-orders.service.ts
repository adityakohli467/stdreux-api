import { Injectable, Logger, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Order } from '../../entities/Order';
import { EmailService } from '../../common/services/email.service';
import { InvoiceService } from '../../common/services/invoice.service';
import { NotificationService } from '../../common/services/notification.service';
import { AdminXeroService } from '../admin-xero/admin-xero.service';
import * as crypto from 'crypto';

@Injectable()
export class AdminOrdersService implements OnModuleInit {
  private readonly logger = new Logger(AdminOrdersService.name);

  constructor(
    @InjectRepository(Order)
    private orderRepository: Repository<Order>,
    private dataSource: DataSource,
    private emailService: EmailService,
    private invoiceService: InvoiceService,
    private notificationService: NotificationService,
    private configService: ConfigService,
    private xeroService: AdminXeroService,
  ) { }

  async onModuleInit() {
    try {
      await this.dataSource.query(`
        ALTER TABLE orders 
        ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50),
        ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS subscription_start_date TIMESTAMP,
        ADD COLUMN IF NOT EXISTS packaging_status INT DEFAULT 0
      `);
      this.logger.log('Ensured payment, subscription, and packaging columns exist in orders table');
    } catch (error) {
      this.logger.error('Failed to add columns to orders table:', error);
    }
  }

  async findAll(query: any): Promise<any> {
    const {
      limit = 20,
      offset = 0,
      status,
      search,
      from_date,
      to_date,
      location_id,
      min_amount,
      max_amount,
      order_type,
      wholesale,
    } = query;

    const params: any[] = [];
    let paramIndex = 1;

    const customerJoinType = wholesale === 'true' ? 'INNER JOIN' : 'LEFT JOIN';

    // Check for payment columns in orders table
    const ordersColumnCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'orders' 
      AND column_name IN ('payment_method', 'payment_status', 'customer_from')
    `);
    const existingOrdersColumns = ordersColumnCheck.map((row: any) => row.column_name);
    const hasPaymentMethod = existingOrdersColumns.includes('payment_method');
    const hasPaymentStatus = existingOrdersColumns.includes('payment_status');
    const hasCustomerFrom = existingOrdersColumns.includes('customer_from');

    let sqlQuery = `
      SELECT 
        o.order_id,
        o.order_total,
        o.order_status,
        o.delivery_date_time,
        o.delivery_address,
        o.delivery_method,
        o.standing_order,
        o.location_id,
        o.date_added,
        o.date_modified,
        o.delivery_fee,
        o.coupon_id,
        o.coupon_discount as stored_coupon_discount,
        o.user_id,
        COALESCE(o.packaging_status::int, 0) as packaging_status,
        COALESCE(o.is_completed::int, 0) as is_completed,
        ${hasCustomerFrom ? 'o.customer_from' : "'portal'"} as order_made_from,
        ${hasPaymentMethod ? 'o.payment_method' : "NULL as payment_method"},
        ${hasPaymentStatus ? 'o.payment_status' : "NULL as payment_status"},
        c.firstname,
        c.lastname,
        c.email,
        c.telephone,
        c.customer_type,
        co.company_name,
        d.department_name,
        l.location_name,
        cp.coupon_code,
        cp.type as coupon_type,
        cp.coupon_discount,
        CASE 
          WHEN EXISTS (
            SELECT 1 FROM payment_history ph 
            WHERE ph.order_id = o.order_id 
            AND ph.payment_status = 'succeeded'
          ) THEN true
          ELSE false
        END as has_successful_payment,
        CASE 
          WHEN EXISTS (
            SELECT 1 FROM xero_invoice_sync xis 
            WHERE xis.order_id = o.order_id
          ) THEN true
          ELSE false
        END as xero_synced
      FROM orders o
      ${customerJoinType} customer c ON o.customer_id = c.customer_id
      LEFT JOIN company co ON c.company_id = co.company_id
      LEFT JOIN department d ON c.department_id = d.department_id
      LEFT JOIN locations l ON o.location_id = l.location_id
      LEFT JOIN coupon cp ON o.coupon_id = cp.coupon_id
      WHERE 1=1
      AND o.order_status NOT IN (0, 4, 7, 8, 9) -- Exclude Quote-related statuses (Draft, Sent, Approved, Rejected, Modify)
      -- Note: Status 1 (New) orders ARE included in the orders list
    `;

    if (wholesale === 'true') {
      sqlQuery += ` AND c.customer_type IS NOT NULL`;
      sqlQuery += ` AND (c.customer_type LIKE '%Wholesale%' OR c.customer_type LIKE '%Wholesaler%')`;
      sqlQuery += ` AND o.order_status != 0`;
    } else {
      // Always exclude quotes (status 0) from orders list
      sqlQuery += ` AND o.order_status != 0`;

      if (order_type) {
        const now = new Date();
        if (order_type === 'past') {
          sqlQuery += ` AND o.standing_order = 0 AND (o.delivery_date_time < $${paramIndex++} OR o.order_status = 5)`;
          params.push(now.toISOString());
        } else if (order_type === 'future') {
          // Include both regular future orders and subscription-generated future orders
          sqlQuery += ` AND (
            (o.standing_order = 0 AND (o.delivery_date_time >= $${paramIndex} OR o.delivery_date_time IS NULL))
            OR o.order_id IN (
              SELECT generated_order_id FROM future_orders 
              WHERE status = 'generated' AND scheduled_delivery_date >= $${paramIndex}
            )
            OR o.order_id IN (
              SELECT subscription_order_id FROM future_orders 
              WHERE status = 'pending' AND scheduled_delivery_date >= $${paramIndex}
            )
          )`;
          params.push(now.toISOString());
          paramIndex++;
        } else if (order_type === 'reminder') {
          // Show standing orders AND delivered+unpaid orders older than 2 weeks
          const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
          sqlQuery += ` AND (
            o.standing_order = 1
            OR (
              o.order_status = 5
              AND ${hasPaymentStatus ? "o.payment_status" : "'pending'"} NOT IN ('succeeded', 'paid', 'completed')
              AND o.order_status != 2
              AND NOT EXISTS (
                SELECT 1 FROM payment_history ph 
                WHERE ph.order_id = o.order_id 
                AND ph.payment_status = 'succeeded'
              )
              AND o.delivery_date_time < $${paramIndex}
            )
          )`;
          params.push(twoWeeksAgo);
          paramIndex++;
        } else if (order_type === 'late') {
          sqlQuery += ` AND o.standing_order = 0 AND o.delivery_date_time < $${paramIndex++} AND o.order_status != 5`;
          params.push(now.toISOString());
        }
      }
    }

    if (status !== undefined) {
      sqlQuery += ` AND o.order_status = $${paramIndex++}`;
      params.push(Number(status));
    }

    if (location_id) {
      sqlQuery += ` AND o.location_id = $${paramIndex++}`;
      params.push(Number(location_id));
    }

    if (min_amount) {
      sqlQuery += ` AND o.order_total >= $${paramIndex++}`;
      params.push(Number(min_amount));
    }

    if (max_amount) {
      sqlQuery += ` AND o.order_total <= $${paramIndex++}`;
      params.push(Number(max_amount));
    }

    if (search) {
      sqlQuery += ` AND (
        CAST(o.order_id AS TEXT) ILIKE $${paramIndex} OR
        c.firstname ILIKE $${paramIndex} OR
        c.lastname ILIKE $${paramIndex} OR
        c.email ILIKE $${paramIndex} OR
        co.company_name ILIKE $${paramIndex} OR
        d.department_name ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (from_date) {
      sqlQuery += ` AND o.delivery_date_time >= $${paramIndex++}`;
      params.push(from_date);
    }

    if (to_date) {
      sqlQuery += ` AND o.delivery_date_time <= $${paramIndex++}`;
      params.push(to_date);
    }

    const countQuery = `SELECT COUNT(*) FROM (${sqlQuery}) as count_query`;
    const countResult = await this.dataSource.query(countQuery, params);
    const count = parseInt(countResult[0].count);

    // Sort by date_added DESC first (latest first), then by delivery_date_time DESC
    sqlQuery += ` ORDER BY o.date_added DESC, o.delivery_date_time DESC NULLS LAST`;
    sqlQuery += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(Number(limit), Number(offset));

    const result = await this.dataSource.query(sqlQuery, params);

    const orderIds = result.map((row: any) => row.order_id);
    let productsMap = new Map();

    if (orderIds.length > 0) {
      const productsQuery = `
        SELECT 
          op.order_id,
          SUM(op.total) as order_subtotal
        FROM order_product op
        WHERE op.order_id = ANY($1)
        GROUP BY op.order_id
      `;
      const productsResult = await this.dataSource.query(productsQuery, [orderIds]);

      productsResult.forEach((row: any) => {
        productsMap.set(row.order_id, parseFloat(row.order_subtotal || 0));
      });
    }

    const orders = result.map((row: any) => {
      let subtotal = productsMap.get(row.order_id) || 0;

      // Calculate wholesale discount - no default, must be explicitly set per customer
      let wholesaleDiscount = 0;
      // No automatic 10%/15% discount based on customer type

      const afterWholesaleDiscount = subtotal - wholesaleDiscount;

      // Calculate coupon discount (applied after wholesale discount)
      let couponDiscount = 0;
      let couponCode: string | null = null;
      // Check if coupon_id exists (even if JOIN returns NULL due to deleted coupon)
      if (row.coupon_id) {
        // First, try to use stored coupon_discount from orders table (for historical accuracy)
        if (row.stored_coupon_discount && parseFloat(row.stored_coupon_discount) > 0) {
          couponDiscount = parseFloat(row.stored_coupon_discount);
          couponCode = row.coupon_code || 'DELETED';
        } else if (row.coupon_code && row.coupon_discount) {
          // Coupon still exists - calculate from coupon table
          couponCode = row.coupon_code;
          if (row.coupon_type === 'P') {
            couponDiscount = afterWholesaleDiscount * (parseFloat(row.coupon_discount) / 100);
          } else if (row.coupon_type === 'F') {
            couponDiscount = parseFloat(row.coupon_discount);
          }
          couponDiscount = Math.min(couponDiscount, afterWholesaleDiscount);
        } else {
          // Coupon was deleted but coupon_id exists - use stored order_total to calculate discount
          // Calculate what the total should be without coupon
          const tempAfterDiscount = afterWholesaleDiscount;
          const tempGst = 0; // Removed GST
          const tempDeliveryFee = parseFloat(row.delivery_fee || 0);
          const tempTotal = Math.round((tempAfterDiscount + tempGst + tempDeliveryFee) * 100) / 100;
          // The difference is the coupon discount
          const storedTotal = parseFloat(row.order_total || 0);
          if (storedTotal < tempTotal) {
            couponDiscount = tempTotal - storedTotal;
            couponCode = 'DELETED';
          }
        }
      }

      const afterDiscount = afterWholesaleDiscount - couponDiscount;
      const gst = 0; // Removed GST
      const deliveryFee = parseFloat(row.delivery_fee || 0);
      const calculatedTotal = Math.round((afterDiscount + gst + deliveryFee) * 100) / 100;

      return {
        order_id: row.order_id,
        customer_name: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
        customer_firstname: row.firstname,
        customer_lastname: row.lastname,
        email: row.email,
        telephone: row.telephone,
        customer_type: row.customer_type,
        company: row.company_name,
        department: row.department_name,
        location_name: row.location_name,
        location_id: row.location_id,
        delivery_date: row.delivery_date_time ? new Date(row.delivery_date_time).toISOString().split('T')[0] : null,
        delivery_time: row.delivery_date_time ? new Date(row.delivery_date_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : null,
        subtotal,
        order_total: calculatedTotal,
        calculated_total: calculatedTotal,
        order_status: row.order_status,
        status_name: row.order_status === 5 ? 'Completed' : (row.order_status === 1 ? 'New' : (row.order_status === 2 ? 'Paid' : (row.order_status === 4 ? 'Awaiting Approval' : (row.order_status === 7 ? 'Approved' : 'Updated')))),
        standing_order: row.standing_order,
        user_id: row.user_id,
        date_added: row.date_added,
        date_modified: row.date_modified,
        coupon_code: couponCode,
        coupon_discount: couponDiscount,
        gst,
        order_made_from: row.order_made_from,
        payment_method: row.payment_method,
        payment_status: (row.payment_status === 'succeeded' || row.has_successful_payment || row.order_status === 2) ? 'Paid' : (row.payment_status === 'pay_later' ? 'Pay Later' : 'Not Paid'),
        packaging_status: row.packaging_status || 0,
        is_completed: row.is_completed || 0,
        xero_synced: row.xero_synced || false,
      };
    });

    return {
      orders,
      count,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  async findOne(id: number): Promise<any> {
    const orderQuery = `
      SELECT 
        o.*,
        o.coupon_id,
        c.firstname,
        c.lastname,
        c.email,
        c.telephone,
        c.customer_type,
        c.company_id,
        c.department_id,
        co.company_name,
        co.company_abn,
        d.department_name,
        l.location_name,
        l.pickup_address as location_address,
        l.contact as location_phone,
        l.remittance_email as location_email,
        l.abn as location_abn,
        l.company_name as location_company_name,
        o.coupon_discount as stored_coupon_discount,
        cp.coupon_code,
        cp.type as coupon_type,
        cp.coupon_discount,
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'order_product_id', op.order_product_id,
              'product_id', op.product_id,
              'product_name', COALESCE(p.product_name, 'Unknown Product'),
              'product_description', p.product_description,
              'quantity', op.quantity,
              'price', op.price,
              'total', op.total,
              'product_comment', op.order_product_comment,
              'is_prepared', false,
              'options', COALESCE((
                SELECT json_agg(json_build_object(
                  'option_name', opo.option_name,
                  'option_value', opo.option_value,
                  'option_quantity', opo.option_quantity,
                  'option_price', opo.option_price,
                  'option_total', opo.option_total,
                  'option_value_id', po.option_value_id
                ) ORDER BY opo.order_product_option_id)
                FROM order_product_option opo
                LEFT JOIN product_option po ON opo.product_option_id = po.product_option_id
                WHERE opo.order_product_id = op.order_product_id
              ), '[]'::json)
            ) ORDER BY op.order_product_id
          )
          FROM order_product op
          LEFT JOIN product p ON op.product_id = p.product_id
          WHERE op.order_id = o.order_id
        ), '[]'::json) as order_products
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      LEFT JOIN company co ON c.company_id = co.company_id
      LEFT JOIN department d ON c.department_id = d.department_id
      LEFT JOIN locations l ON o.location_id = l.location_id
      LEFT JOIN coupon cp ON o.coupon_id = cp.coupon_id
      WHERE o.order_id = $1
    `;
    const orderResult = await this.dataSource.query(orderQuery, [id]);

    if (orderResult.length === 0) {
      throw new NotFoundException('Order not found');
    }

    const order = orderResult[0];

    let orderProducts = order.order_products;
    if (typeof orderProducts === 'string') {
      try {
        orderProducts = JSON.parse(orderProducts);
      } catch (e) {
        this.logger.error('Failed to parse order_products:', e);
        orderProducts = [];
      }
    }
    if (!orderProducts) {
      orderProducts = [];
    }

    // Calculate subtotal including options/add-ons
    let subtotal = 0;
    if (Array.isArray(orderProducts) && orderProducts.length > 0) {
      for (const product of orderProducts) {
        subtotal += parseFloat(product.total || 0);
      }
    }

    // Calculate wholesale discount - no default, must be explicitly set per customer
    let wholesaleDiscount = 0;
    // No automatic 10%/15% discount based on customer type

    // Calculate coupon discount (applied after wholesale discount)
    let couponDiscount = 0;
    let couponCode: string | null = order.coupon_code || null;
    const subtotalAfterWholesale = subtotal - wholesaleDiscount;
    // Check if coupon_id exists (even if JOIN returns NULL due to deleted coupon)
    if (order.coupon_id) {
      if (order.coupon_code && order.coupon_discount) {
        // Coupon information available from JOIN
        couponCode = order.coupon_code;
        if (order.coupon_type === 'P') {
          couponDiscount = subtotalAfterWholesale * (parseFloat(order.coupon_discount) / 100);
        } else if (order.coupon_type === 'F') {
          couponDiscount = parseFloat(order.coupon_discount);
        }
        couponDiscount = Math.min(couponDiscount, subtotalAfterWholesale);
      } else {
        // Coupon was deleted but coupon_id exists - calculate discount from stored order_total
        // Calculate what the total should be without coupon
        const tempAfterDiscount = subtotalAfterWholesale;
        const tempGst = 0; // Removed GST
        const tempDeliveryFee = parseFloat(order.delivery_fee || 0);
        const tempTotal = Math.round((tempAfterDiscount + tempGst + tempDeliveryFee) * 100) / 100;
        // The difference is the coupon discount
        const storedTotal = parseFloat(order.order_total || 0);
        if (storedTotal < tempTotal) {
          couponDiscount = tempTotal - storedTotal;
          couponCode = 'DELETED'; // Indicate coupon was deleted
        }
      }
    }

    const afterDiscount = subtotalAfterWholesale - couponDiscount;
    const gst = 0; // Removed GST
    const deliveryFee = parseFloat(order.delivery_fee || 0);
    const orderTotal = Math.round((afterDiscount + gst + deliveryFee) * 100) / 100;

    // Check payment status from payment_history
    const paymentStatusQuery = `
      SELECT payment_status 
      FROM payment_history 
      WHERE order_id = $1 
      AND payment_status = 'succeeded' 
      LIMIT 1
    `;
    const paymentStatusResult = await this.dataSource.query(paymentStatusQuery, [id]);
    const hasSuccessfulPayment = paymentStatusResult.length > 0;

    // Determine payment status
    let paymentStatus = 'Not Paid';
    if (order.payment_status === 'succeeded' || hasSuccessfulPayment || order.order_status === 2) {
      paymentStatus = 'Paid';
    } else if (order.payment_status === 'pay_later') {
      paymentStatus = 'Pay Later';
    } else if (order.order_status === 7 || order.order_status === 5 || order.is_completed === 1) {
      paymentStatus = 'Completed';
    }

    const { order_products: _, ...orderWithoutProducts } = order;

    // Format delivery_date and delivery_time from delivery_date_time for edit mode
    let formattedDeliveryDate: string | null = null;
    let formattedDeliveryTime: string | null = null;

    if (order.delivery_date_time) {
      const deliveryDate = new Date(order.delivery_date_time);
      // Format date as YYYY-MM-DD for date input
      formattedDeliveryDate = deliveryDate.toISOString().split('T')[0];
      // Format time as HH:MM for time input (24-hour format)
      const hours = String(deliveryDate.getHours()).padStart(2, '0');
      const minutes = String(deliveryDate.getMinutes()).padStart(2, '0');
      formattedDeliveryTime = `${hours}:${minutes}`;
    }

    // Fetch company settings for display
    let companySettings: Record<string, string> = {};
    try {
      const settingsResult = await this.dataSource.query(
        `SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('company_name', 'company_email', 'company_phone', 'company_abn', 'company_address')`
      );
      settingsResult.forEach((row: any) => {
        companySettings[row.setting_key] = row.setting_value;
      });
    } catch (e) {
      // Settings table may not exist
    }

    return {
      order: {
        ...orderWithoutProducts,
        status_name: order.order_status === 5 ? 'Completed' : (order.order_status === 1 ? 'New' : (order.order_status === 2 ? 'Paid' : (order.order_status === 4 ? 'Awaiting Approval' : (order.order_status === 7 ? 'Approved' : 'Updated')))),
        // Explicitly ensure delivery fields are included
        delivery_date_time: order.delivery_date_time || null,
        delivery_time: formattedDeliveryTime || null,
        delivery_address: order.delivery_address || null,
        delivery_method: order.delivery_method || null,
        delivery_contact: order.delivery_contact || null,
        delivery_details: order.delivery_details || null,
        account_email: order.account_email || null,
        cost_center: order.cost_center || null,
        order_products: orderProducts,
        products: orderProducts, // Also include as 'products' for consistency with quotes
        customer_order_name: `${order.firstname || ''} ${order.lastname || ''}`.trim() || order.customer_order_name || 'N/A',
        customer_order_email: order.email || order.customer_order_email || null,
        customer_order_telephone: order.telephone || order.customer_order_telephone || null,
        subtotal: subtotal,
        wholesale_discount: wholesaleDiscount,
        coupon_discount: couponDiscount,
        coupon_code: couponCode,
        coupon_id: order.coupon_id || null, // Ensure coupon_id is included
        total_discount: wholesaleDiscount + couponDiscount,
        after_wholesale_discount: subtotalAfterWholesale,
        after_discount: afterDiscount,
        gst: gst,
        calculated_total: orderTotal,
        payment_status: paymentStatus,
        order_total: orderTotal,
        order_made_from: order.customer_from || null,
        // Company/location settings for display
        company_settings: {
          company_name: order.location_company_name || companySettings.company_name || '',
          company_abn: order.location_abn || companySettings.company_abn || '',
          company_address: order.location_address || companySettings.company_address || '',
          company_phone: order.location_phone || companySettings.company_phone || '',
          company_email: order.location_email || companySettings.company_email || '',
        },
      },
    };
  }

  async create(createOrderDto: any, userId?: number): Promise<any> {
    // Validate required fields BEFORE starting transaction
    if (!createOrderDto || !createOrderDto.customer_id) {
      throw new BadRequestException('Customer ID is required');
    }

    if (!createOrderDto.location_id) {
      throw new BadRequestException('Location ID is required');
    }

    if (!createOrderDto.products || !Array.isArray(createOrderDto.products) || createOrderDto.products.length === 0) {
      throw new BadRequestException('At least one product is required');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const {
        customer_id,
        location_id,
        delivery_date, // New: separate date field
        delivery_date_time, // Optional - for backward compatibility
        delivery_time, // New: separate time field for St Dreux
        delivery_fee = 0,
        order_comments,
        coupon_code,
        delivery_address,
        delivery_method,
        account_email,
        cost_center,
        delivery_contact,
        delivery_details,
        standing_order = 0,
        subscription_start_date,
        payment_method = 'stripe',
        products = [],
      } = createOrderDto;

      // Get customer details
      const customerResult = await queryRunner.query(`SELECT customer_type FROM customer WHERE customer_id = $1`, [customer_id]);
      const customer = customerResult[0];
      const customerType = customer?.customer_type || 'Retail';
      const isWholesale = customerType && (customerType.includes('Wholesale') || customerType.includes('Wholesaler'));

      // Calculate totals - product.total = final line total including options
      let subtotal = 0;
      for (const product of products) {
        const productPrice = parseFloat(product.price) || 0;
        const qty = parseInt(product.quantity) || 1;
        let optionsTotal = 0;
        const options = product.add_ons || product.options || [];
        
        if (Array.isArray(options)) {
          for (const addon of options) {
            optionsTotal += (parseFloat(addon.option_price) || 0) * (parseInt(addon.option_quantity) || qty);
          }
        }
        
        // Line total: base price + options. For variant products (price=0), options ARE the pricing
        const lineTotal = (productPrice * qty) + optionsTotal;
        subtotal += lineTotal;
      }

      let wholesaleDiscount = 0;
      // Wholesale discount - no default, must be explicitly set per customer

      let couponDiscount = 0;
      let couponId = null;
      const subtotalAfterWholesale = subtotal - wholesaleDiscount;
      if (coupon_code) {
        // Trim whitespace and make case-insensitive lookup
        const normalizedCouponCode = (coupon_code || '').trim().toUpperCase();
        const couponResult = await queryRunner.query(
          `SELECT coupon_id, coupon_code, type, coupon_discount, status
           FROM coupon 
           WHERE UPPER(TRIM(coupon_code)) = $1 AND status = 1`,
          [normalizedCouponCode],
        );

        if (couponResult.length > 0) {
          const coupon = couponResult[0];
          couponId = coupon.coupon_id;

          // Apply coupon discount after wholesale discount
          if (coupon.type === 'P') {
            couponDiscount = subtotalAfterWholesale * (parseFloat(coupon.coupon_discount) / 100);
          } else if (coupon.type === 'F') {
            couponDiscount = parseFloat(coupon.coupon_discount);
          }

          couponDiscount = Math.min(couponDiscount, subtotalAfterWholesale);
        } else {
          // Log warning if coupon not found (for debugging)
          this.logger.warn(`Coupon not found or inactive: ${coupon_code} (normalized: ${normalizedCouponCode})`);
        }
      }

      const afterDiscount = subtotalAfterWholesale - couponDiscount;
      const gst = 0; // Removed GST
      const deliveryFeeAmount = parseFloat(delivery_fee || 0);
      const orderTotal = Math.round((afterDiscount + gst + deliveryFeeAmount) * 100) / 100;

      // Build delivery_date_time: prioritize delivery_date/delivery_time over delivery_date_time
      let finalDeliveryDateTime: string | null = null;

      // Normalize delivery_date - trim whitespace and handle empty strings
      const normalizedDeliveryDate = delivery_date && typeof delivery_date === 'string' && delivery_date.trim() ? delivery_date.trim() : null;
      // Normalize delivery_time - trim whitespace and handle empty strings
      const normalizedDeliveryTime = delivery_time && typeof delivery_time === 'string' && delivery_time.trim() ? delivery_time.trim() : null;

      // Priority: delivery_date + delivery_time > delivery_date_time > null
      if (normalizedDeliveryDate) {
        if (normalizedDeliveryTime) {
          const timeParts = normalizedDeliveryTime.replace(/:/g, '').match(/.{1,2}/g) || [];
          if (timeParts.length >= 2 && timeParts[0] && timeParts[1]) {
            const formattedTime = `${timeParts[0].padStart(2, '0')}:${timeParts[1].padStart(2, '0')}:00`;
            finalDeliveryDateTime = `${normalizedDeliveryDate} ${formattedTime}`;
          } else {
            finalDeliveryDateTime = `${normalizedDeliveryDate} 00:00:00`;
          }
        } else {
          finalDeliveryDateTime = `${normalizedDeliveryDate} 00:00:00`;
        }
      } else if (delivery_date_time && typeof delivery_date_time === 'string' && delivery_date_time.trim()) {
        finalDeliveryDateTime = delivery_date_time.trim();
      }

      // Create order
      const branch_id = location_id || 1;
      const shipping_method = delivery_method === 'pickup' ? 2 : 1;
      const user_id = userId || 1;

      // Check which columns exist
      const orderColCheck = await queryRunner.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'orders' 
        AND column_name IN ('payment_method', 'payment_status', 'subscription_start_date', 'customer_from')
      `);
      const existingCols = orderColCheck.map((r: any) => r.column_name);
      const hasPM = existingCols.includes('payment_method');
      const hasPS = existingCols.includes('payment_status');
      const hasSD = existingCols.includes('subscription_start_date');
      const hasCF = existingCols.includes('customer_from');

      // Build dynamic column list
      const baseCols = [
        'customer_id', 'location_id', 'branch_id', 'shipping_method', 'delivery_date_time',
        'delivery_fee', 'order_total', 'order_status', 'order_comments', 'coupon_id',
        'coupon_discount', 'delivery_address', 'delivery_method', 'account_email',
        'cost_center', 'delivery_contact', 'delivery_details', 'standing_order', 'user_id',
      ];
      const baseValues: any[] = [
        customer_id, location_id, branch_id, shipping_method, finalDeliveryDateTime,
        deliveryFeeAmount, orderTotal, 1, order_comments, couponId,
        couponDiscount, delivery_address, delivery_method, account_email,
        cost_center, delivery_contact, delivery_details, standing_order, user_id,
      ];

      if (hasCF) { baseCols.push('customer_from'); baseValues.push('admin'); }
      if (hasPM) { baseCols.push('payment_method'); baseValues.push(payment_method || 'stripe'); }
      if (hasPS) { baseCols.push('payment_status'); baseValues.push(payment_method === 'pay_later' ? 'pay_later' : 'pending'); }
      if (hasSD) { baseCols.push('subscription_start_date'); baseValues.push(subscription_start_date || null); }

      const placeholders = baseCols.map((_, i) => `$${i + 1}`).join(', ');

      const orderResult = await queryRunner.query(
        `INSERT INTO orders (${baseCols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        baseValues,
      );

      const order = orderResult[0];

      // Create order products
      for (let index = 0; index < products.length; index++) {
        const product = products[index];
        const qty = parseInt(product.quantity) || 1;
        const productPrice = parseFloat(product.price) || 0;
        const sortOrder = product.sort_order !== undefined ? product.sort_order : index + 1;
        const excludeGst = product.exclude_gst !== undefined ? product.exclude_gst : 0;

        // Calculate the full line total including options
        let optionsTotal = 0;
        const addOns = product.add_ons || product.options || [];
        if (Array.isArray(addOns)) {
          for (const addon of addOns) {
            optionsTotal += (parseFloat(addon.option_price) || 0) * (parseInt(addon.option_quantity) || qty);
          }
        }
        const productTotal = (productPrice * qty) + optionsTotal;

        const orderProductResult = await queryRunner.query(
          `INSERT INTO order_product (order_id, product_id, quantity, price, total, order_product_comment, sort_order, exclude_gst)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING order_product_id`,
          [
            order.order_id,
            product.product_id,
            qty,
            productPrice,
            productTotal,
            product.comment?.trim() || null,
            sortOrder,
            excludeGst
          ],
        );

        const orderProductId = orderProductResult[0].order_product_id;

        // Create order product options
        if (Array.isArray(addOns)) {
          for (const addon of addOns) {
            const optionQuantity = parseInt(addon.option_quantity) || qty;
            const optionPrice = parseFloat(addon.option_price || 0);
            const optionTotal = optionQuantity * optionPrice;

            await queryRunner.query(
              `INSERT INTO order_product_option (
                order_id, order_product_id, product_option_id, option_name, option_value,
                option_quantity, option_price, option_total
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                order.order_id, // Add order_id
                orderProductId,
                addon.product_option_id || 0, // product_option_id is NOT NULL, use 0 as default
                addon.option_name || '',
                addon.option_value || '',
                optionQuantity,
                optionPrice,
                optionTotal, // Add option_total
              ],
            );
          }
        }
      }

      await queryRunner.commitTransaction();
      return this.findOne(order.order_id);
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      this.logger.error('Create order error:', error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async update(id: number, updateOrderDto: any, userId?: number): Promise<any> {
    // Validate required fields
    if (!updateOrderDto || !updateOrderDto.customer_id) {
      throw new BadRequestException('Customer ID is required');
    }

    if (!updateOrderDto.location_id) {
      throw new BadRequestException('Location ID is required');
    }

    if (!updateOrderDto.products || !Array.isArray(updateOrderDto.products) || updateOrderDto.products.length === 0) {
      throw new BadRequestException('At least one product is required');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const {
        customer_id,
        location_id,
        delivery_date,
        delivery_date_time,
        delivery_time,
        delivery_fee = 0,
        order_comments,
        coupon_code,
        delivery_address,
        delivery_method,
        account_email,
        cost_center,
        delivery_contact,
        delivery_details,
        products = [],
      } = updateOrderDto;

      // Get customer details
      const customerResult = await queryRunner.query(`SELECT customer_type FROM customer WHERE customer_id = $1`, [customer_id]);
      const customer = customerResult[0];
      const customerType = customer?.customer_type || 'Retail';
      const isWholesale = customerType && (customerType.includes('Wholesale') || customerType.includes('Wholesaler'));

      // Calculate totals - product.total = final line total including options
      let subtotal = 0;
      for (const product of products) {
        const productPrice = parseFloat(product.price) || 0;
        const qty = parseInt(product.quantity) || 1;
        let optionsTotal = 0;
        const options = product.add_ons || product.options || [];
        
        if (Array.isArray(options)) {
          for (const addon of options) {
            optionsTotal += (parseFloat(addon.option_price) || 0) * (parseInt(addon.option_quantity) || qty);
          }
        }
        
        // Line total: base price + options. For variant products (price=0), options ARE the pricing
        subtotal += (productPrice * qty) + optionsTotal;
      }

      let wholesaleDiscount = 0;
      // Wholesale discount - no default, must be explicitly set per customer
      // No automatic 10%/15% discount based on customer type

      let couponDiscount = 0;
      let couponId = null;
      const subtotalAfterWholesale = subtotal - wholesaleDiscount;
      if (coupon_code) {
        // Trim whitespace and make case-insensitive lookup
        const normalizedCouponCode = (coupon_code || '').trim().toUpperCase();
        const couponResult = await queryRunner.query(
          `SELECT coupon_id, coupon_code, type, coupon_discount, status
           FROM coupon 
           WHERE UPPER(TRIM(coupon_code)) = $1 AND status = 1`,
          [normalizedCouponCode],
        );

        if (couponResult.length > 0) {
          const coupon = couponResult[0];
          couponId = coupon.coupon_id;

          if (coupon.type === 'P') {
            couponDiscount = subtotalAfterWholesale * (parseFloat(coupon.coupon_discount) / 100);
          } else if (coupon.type === 'F') {
            couponDiscount = parseFloat(coupon.coupon_discount);
          }

          couponDiscount = Math.min(couponDiscount, subtotalAfterWholesale);
        } else {
          // Log warning if coupon not found (for debugging)
          this.logger.warn(`Coupon not found or inactive: ${coupon_code} (normalized: ${normalizedCouponCode})`);
        }
      }

      const totalDiscount = wholesaleDiscount + couponDiscount;
      const afterDiscount = subtotalAfterWholesale - couponDiscount;
      const gst = 0; // Removed GST
      const deliveryFeeAmount = parseFloat(delivery_fee || 0);
      const orderTotal = Math.round((afterDiscount + gst + deliveryFeeAmount) * 100) / 100;

      // Build delivery_date_time: prioritize delivery_date_time if provided, otherwise build from date/time
      // Allow setting just date (with default time 00:00:00) or both date and time
      let finalDeliveryDateTime: string | null = null;

      if (delivery_date_time && typeof delivery_date_time === 'string' && delivery_date_time.trim()) {
        // Use provided delivery_date_time if available
        finalDeliveryDateTime = delivery_date_time.trim();
      } else if (delivery_date && typeof delivery_date === 'string' && delivery_date.trim()) {
        // Build from delivery_date and delivery_time
        const normalizedDate = delivery_date.trim();
        if (delivery_time && typeof delivery_time === 'string' && delivery_time.trim()) {
          // Both date and time provided
          const timeParts = delivery_time.trim().replace(/:/g, '').match(/.{1,2}/g) || [];
          if (timeParts.length >= 2 && timeParts[0] && timeParts[1]) {
            const formattedTime = `${timeParts[0].padStart(2, '0')}:${timeParts[1].padStart(2, '0')}:00`;
            finalDeliveryDateTime = `${normalizedDate} ${formattedTime}`;
          } else {
            // Invalid time format, use default time
            finalDeliveryDateTime = `${normalizedDate} 00:00:00`;
          }
        } else {
          // Only date provided, use default time (start of day)
          finalDeliveryDateTime = `${normalizedDate} 00:00:00`;
        }
      }
      // If no date provided, keep as null for future orders

      // Check current order status - if it's a quote (status 0), convert to order (status 1)
      const currentOrderCheck = await queryRunner.query(
        `SELECT order_status FROM orders WHERE order_id = $1`,
        [id],
      );

      const currentStatus = currentOrderCheck.length > 0 ? currentOrderCheck[0].order_status : null;
      // If updating a quote (status 0), convert it to an order (status 1)
      const newOrderStatus = currentStatus === 0 ? 1 : currentStatus;

      // Update order
      const branch_id = location_id || 1;
      const shipping_method = delivery_method === 'pickup' ? 2 : 1;
      const user_id = userId || 1;

      const orderResult = await queryRunner.query(
        `UPDATE orders 
         SET customer_id = $1,
             location_id = $2,
             branch_id = $3,
             shipping_method = $4,
             delivery_date_time = $5,
             delivery_fee = $6,
             order_total = $7,
             order_comments = $8,
             coupon_id = $9,
             coupon_discount = $10,
             delivery_address = $11,
             delivery_method = $12,
             account_email = $13,
             cost_center = $14,
             delivery_contact = $15,
             delivery_details = $16,
             user_id = $17,
             order_status = $18,
             date_modified = CURRENT_TIMESTAMP
         WHERE order_id = $19 AND standing_order = 0
         RETURNING *`,
        [
          customer_id,
          location_id,
          branch_id,
          shipping_method,
          finalDeliveryDateTime,
          deliveryFeeAmount,
          orderTotal,
          order_comments || null,
          couponId,
          couponDiscount, // Store coupon discount amount for historical accuracy
          (delivery_address && typeof delivery_address === 'string' && delivery_address.trim()) ? delivery_address.trim() : null,
          delivery_method || null,
          account_email?.trim() || null,
          cost_center?.trim() || null,
          delivery_contact?.trim() || null,
          delivery_details?.trim() || null,
          user_id,
          newOrderStatus, // Convert quote (0) to order (1) if updating
          id,
        ],
      );

      if (!orderResult || orderResult.length === 0) {
        throw new NotFoundException('Order not found or cannot be updated');
      }

      const order = orderResult[0];

      // Delete existing order products (cascade will handle order_product_option if FK exists)
      await queryRunner.query(`DELETE FROM order_product_option WHERE order_id = $1`, [id]);
      await queryRunner.query(`DELETE FROM order_product WHERE order_id = $1`, [id]);

      // Create updated order products
      for (let index = 0; index < products.length; index++) {
        const product = products[index];
        const qty = parseInt(product.quantity) || 1;
        const productPrice = parseFloat(product.price) || 0;
        const sortOrder = product.sort_order !== undefined ? product.sort_order : index + 1;
        const excludeGst = product.exclude_gst !== undefined ? product.exclude_gst : 0;

        // Calculate the full line total including options
        let optionsTotal = 0;
        const addOns = product.add_ons || product.options || [];
        if (Array.isArray(addOns)) {
          for (const addon of addOns) {
            optionsTotal += (parseFloat(addon.option_price || addon.price || 0)) * (parseInt(addon.option_quantity || addon.quantity) || qty);
          }
        }
        const productTotal = (productPrice * qty) + optionsTotal;

        const orderProductResult = await queryRunner.query(
          `INSERT INTO order_product (order_id, product_id, quantity, price, total, order_product_comment, sort_order, exclude_gst)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING order_product_id`,
          [
            id,
            product.product_id,
            qty,
            productPrice,
            productTotal,
            product.comment || null,
            sortOrder,
            excludeGst,
          ],
        );

        const orderProductId = orderProductResult[0].order_product_id;

        // Save product options/add-ons
        if (Array.isArray(addOns)) {
          for (const addon of addOns) {
            const optionQuantity = parseInt(addon.option_quantity || addon.quantity) || qty;
            const optionPrice = parseFloat(addon.option_price || addon.price || 0);
            const optionTotal = optionQuantity * optionPrice;

            await queryRunner.query(
              `INSERT INTO order_product_option (
                order_id, order_product_id, product_option_id, option_name, option_value,
                option_quantity, option_price, option_total
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                id,
                orderProductId,
                addon.product_option_id || 0,
                addon.option_name || addon.name || '',
                addon.option_value || '',
                optionQuantity,
                optionPrice,
                optionTotal,
              ],
            );
          }
        }
      }

      await queryRunner.commitTransaction();

      return {
        order: order,
        message: 'Order updated successfully',
      };
    } catch (error: any) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to update order ${id}:`, error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async updateStatus(id: number, orderStatus: number, comment?: string): Promise<any> {
    const order = await this.orderRepository.findOne({ where: { order_id: id } });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const oldStatus = order.order_status;
    const updateData: any = {
      order_status: Number(orderStatus),
      date_modified: new Date(),
    };

    if (comment) {
      if (orderStatus === 0) {
        updateData.cancel_comment = comment;
      } else if (orderStatus === 7 || orderStatus === 8) {
        updateData.approval_comments = comment;
      }
    }

    await this.orderRepository.update({ order_id: id }, updateData);

    // Send email notification for important status changes
    try {
      const orderData = await this.findOne(id);
      const orderDetails = orderData.order;
      const recipientEmail = orderDetails.customer_order_email || orderDetails.email || orderDetails.customer_email;

      if (recipientEmail && oldStatus !== orderStatus) {
        const statusMessages: Record<number, string> = {
          0: 'cancelled',
          2: 'paid',
          3: 'processing',
          4: 'awaiting approval',
          5: 'completed',
          7: 'approved',
          8: 'rejected',
        };

        const statusMessage = statusMessages[orderStatus] || 'updated';
        const customerName = orderDetails.customer_order_name ||
          `${orderDetails.firstname || ''} ${orderDetails.lastname || ''}`.trim() ||
          'Customer';
        const companyName = this.configService.get<string>('COMPANY_NAME') || 'Sendrix';

        // Only send email for important status changes
        if ([0, 2, 3, 5, 7, 8].includes(orderStatus)) {
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
    .status-badge { display: inline-block; padding: 8px 16px; border-radius: 5px; font-weight: bold; margin: 10px 0; }
    .status-paid { background-color: #28a745; color: white; }
    .status-processing { background-color: #17a2b8; color: white; }
    .status-completed { background-color: #28a745; color: white; }
    .status-cancelled { background-color: #dc3545; color: white; }
    .status-approved { background-color: #28a745; color: white; }
    .status-rejected { background-color: #dc3545; color: white; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Order Status Update</h1>
    </div>
    <div class="content">
      <p>Dear ${customerName},</p>
      <p>Your order #${id} status has been updated.</p>
      
      <div style="margin: 20px 0;">
        <span class="status-badge status-${statusMessage.replace(' ', '-')}">${statusMessage.charAt(0).toUpperCase() + statusMessage.slice(1)}</span>
      </div>

      ${comment ? `<p><strong>Note:</strong> ${comment}</p>` : ''}

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

          await this.emailService.sendEmail({
            to: recipientEmail,
            subject: `Order #${id} Status Update - ${statusMessage.charAt(0).toUpperCase() + statusMessage.slice(1)}`,
            html: emailHtml,
          });

          this.logger.log(`Order status update email sent to ${recipientEmail} for order #${id}`);
        }
      }
    } catch (emailError) {
      this.logger.error('Failed to send order status update email:', emailError);
      // Don't fail the status update if email fails
    }

    return this.findOne(id);
  }

  async markAsCompleted(id: number): Promise<any> {
    const order = await this.orderRepository.findOne({ where: { order_id: id } });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // Set is_completed = 1 and order_status = 5 (Completed)
    await this.orderRepository.update(
      { order_id: id },
      {
        order_status: 5,
        is_completed: 1,
        date_modified: new Date(),
      }
    );

    return this.findOne(id);
  }

  async updatePackagingStatus(id: number, packagingStatus: number): Promise<any> {
    const order = await this.orderRepository.findOne({ where: { order_id: id } });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // Update packaging_status: 0=New Order, 1=Printed, 2=Packed, 3=Delivered
    const updateData: any = { packaging_status: packagingStatus, date_modified: new Date() };

    // If delivered (3), also mark as completed
    if (packagingStatus === 3) {
      updateData.order_status = 5;
      updateData.is_completed = 1;
    }

    await this.orderRepository.update({ order_id: id }, updateData);

    return this.findOne(id);
  }

  async updatePackagingComment(id: number, packagingComment: string): Promise<any> {
    const order = await this.orderRepository.findOne({ where: { order_id: id } });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    await this.orderRepository.update({ order_id: id }, { packaging_comment: packagingComment, date_modified: new Date() } as any);

    return this.findOne(id);
  }

  async markAsPaid(id: number, userId?: number): Promise<any> {
    const order = await this.orderRepository.findOne({ where: { order_id: id } });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const transactionId = `manual_${id}_${Date.now()}`;

      // Update payment info - only update payment_status, NOT order_status
      await queryRunner.query(
        `UPDATE orders 
         SET payment_status = 'succeeded',
             payment_date = CURRENT_TIMESTAMP,
             payment_gateway = 'manual',
             payment_transaction_id = $1,
             payment_response = $2,
             date_modified = CURRENT_TIMESTAMP
         WHERE order_id = $3`,
        [transactionId, JSON.stringify({ manual_payment: true, marked_by_user_id: userId }), id],
      );

      // Add to payment history
      await queryRunner.query(
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
          created_at,
          processed_at,
          notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $12)`,
        [
          id,
          transactionId,
          'manual_payment',
          'succeeded',
          'manual',
          order.order_total,
          'AUD',
          order.customer_id || null,
          order.email || null,
          JSON.stringify({ manual: true, admin_id: userId }),
          transactionId,
          'Marked as paid by admin'
        ],
      );

      await queryRunner.commitTransaction();

      // Send payment confirmation email
      try {
        const orderInfoExt = await this.findOne(id);
        const orderDetailsObject = orderInfoExt.order;
        const custNameDisplay = orderDetailsObject.customer_order_name ||
          `${orderDetailsObject.firstname || ''} ${orderDetailsObject.lastname || ''}`.trim() ||
          'Customer';

        const toEmailContactDetail = orderDetailsObject.customer_order_email || orderDetailsObject.email;
        const managerEmailContactDetail = orderDetailsObject.accounts_email || null;
        const emailListToNotifyFinal = managerEmailContactDetail
          ? [toEmailContactDetail, managerEmailContactDetail].filter(Boolean)
          : [toEmailContactDetail].filter(Boolean);

        if (emailListToNotifyFinal.length > 0) {
          const invoiceUrl = await this.invoiceService.getInvoiceUrl(id);

          await this.notificationService.sendNotification({
            templateKey: 'order_payment_received',
            recipientEmail: emailListToNotifyFinal as string[],
            recipientName: custNameDisplay,
            variables: {
              customer_name: custNameDisplay,
              order_number: id.toString(),
              invoice_number: id.toString(),
              amount_paid: `$${Number(order.order_total || 0).toFixed(2)}`,
              company_name: this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee',
              contact_number: this.configService.get<string>('COMPANY_PHONE') || '',
              contact_email: this.configService.get<string>('COMPANY_EMAIL') || '',
            },
            customSubject: `Payment Received – Order #${id.toString()} – ${this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee'}`,
            customBody: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; background-color: #ffffff; }
    .header { background-color: #2952E6; color: white; padding: 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; color: #ffffff; }
    .content { padding: 30px 20px; }
    .footer { padding: 20px; text-align: center; font-size: 12px; color: #777; border-top: 1px solid #eee; }
    .button { display: inline-block; padding: 12px 24px; background-color: #28a745; color: #ffffff !important; text-decoration: none; border-radius: 5px; font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>${this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee'}</h1></div>
    <div class="content">
      <p>Dear ${custNameDisplay},</p>
      <p>Thank you for your payment.</p>
      <p>This email confirms that payment has been successfully received for your order.</p>
      <p>
        Order number: ${id.toString()}<br/>
        Invoice number: ${id.toString()}<br/>
        Payment amount: $${Number(order.order_total || 0).toFixed(2)}
      </p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${invoiceUrl}" class="button"><span style="color: #ffffff !important;">Download Invoice</span></a>
      </div>
      <p>If you have any questions, please contact us at ${this.configService.get<string>('COMPANY_PHONE') || ''} or ${this.configService.get<string>('COMPANY_EMAIL') || ''}.</p>
      <p>Kind regards,<br/>${this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee'} Team</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} ${this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee'}. All rights reserved.
    </div>
  </div>
</body>
</html>`,
            attachments: undefined, // Removed separate invoice attachment as requested
          });
        }
      } catch (emailError) {
        this.logger.error('Failed to send manual payment confirmation email:', emailError);
      }

      // Create invoice in Xero for the paid order
      try {
        const xeroStatus = await this.xeroService.isConnected();
        if (xeroStatus.connected) {
          const xeroResult = await this.xeroService.createInvoiceForOrder(id);
          this.logger.log(`[Xero] Invoice ${xeroResult.invoiceNumber} created for order ${id}`);
        }
      } catch (xeroError) {
        this.logger.error(`[Xero] Failed to create invoice for order ${id}:`, xeroError);
        // Don't fail the payment flow if Xero fails
      }

    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Mark order as paid error:`, error);
      throw error;
    } finally {
      await queryRunner.release();
    }

    return this.findOne(id);
  }


  async delete(id: number): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const checkResult = await queryRunner.query(`SELECT order_id FROM orders WHERE order_id = $1`, [id]);

      if (checkResult.length === 0) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException('Order not found');
      }

      await queryRunner.query(
        `DELETE FROM order_product_option 
         WHERE order_product_id IN (
           SELECT order_product_id FROM order_product WHERE order_id = $1
         )`,
        [id],
      );

      await queryRunner.query(`DELETE FROM order_product WHERE order_id = $1`, [id]);
      await queryRunner.query(`DELETE FROM orders WHERE order_id = $1`, [id]);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Delete order error:', error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * One-time fix: Recalculate order_product.total for all orders where
   * the stored total doesn't match the correct calculation.
   * This fixes orders created before the bug fix where:
   * - Variant products (price=0) had total stored as 0
   * - Admin orders didn't include option prices in the total
   */
  async fixOrderProductTotals(): Promise<any> {
    // Find order_products where price=0 AND total=0 but they have options with prices
    const brokenProducts = await this.dataSource.query(`
      SELECT op.order_product_id, op.order_id, op.quantity, op.price, op.total,
        COALESCE((
          SELECT SUM(opo.option_price * opo.option_quantity)
          FROM order_product_option opo
          WHERE opo.order_product_id = op.order_product_id
        ), 0) as options_total
      FROM order_product op
      WHERE op.price = 0 AND op.total = 0
        AND EXISTS (
          SELECT 1 FROM order_product_option opo
          WHERE opo.order_product_id = op.order_product_id AND opo.option_price > 0
        )
    `);

    let fixedCount = 0;
    for (const row of brokenProducts) {
      // For variant products: total = option_price * product_qty
      // But option_quantity might be stored as 1 (per-unit), so recalculate from options
      const optionsResult = await this.dataSource.query(`
        SELECT option_price, option_quantity
        FROM order_product_option
        WHERE order_product_id = $1
      `, [row.order_product_id]);

      let correctTotal = 0;
      const qty = parseInt(row.quantity) || 1;
      for (const opt of optionsResult) {
        const optPrice = parseFloat(opt.option_price) || 0;
        const optQty = parseInt(opt.option_quantity) || 1;
        // If option_quantity < product quantity, it was stored per-unit — multiply by product qty
        const effectiveQty = optQty < qty ? qty : optQty;
        correctTotal += optPrice * effectiveQty;

        // Also fix the option_quantity if it was stored incorrectly
        if (optQty < qty) {
          await this.dataSource.query(`
            UPDATE order_product_option SET option_quantity = $1, option_total = $2
            WHERE order_product_id = $3 AND option_price = $4
          `, [qty, optPrice * qty, row.order_product_id, optPrice]);
        }
      }

      if (correctTotal > 0) {
        await this.dataSource.query(`
          UPDATE order_product SET total = $1 WHERE order_product_id = $2
        `, [correctTotal, row.order_product_id]);

        // Also update the order's order_total
        const orderSubtotal = await this.dataSource.query(`
          SELECT SUM(total) as subtotal FROM order_product WHERE order_id = $1
        `, [row.order_id]);
        const newSubtotal = parseFloat(orderSubtotal[0]?.subtotal || 0);
        const orderInfo = await this.dataSource.query(`
          SELECT delivery_fee, coupon_discount FROM orders WHERE order_id = $1
        `, [row.order_id]);
        const deliveryFee = parseFloat(orderInfo[0]?.delivery_fee || 0);
        const couponDiscount = parseFloat(orderInfo[0]?.coupon_discount || 0);
        const newTotal = Math.round((newSubtotal - couponDiscount + deliveryFee) * 100) / 100;

        await this.dataSource.query(`
          UPDATE orders SET order_total = $1 WHERE order_id = $2
        `, [newTotal, row.order_id]);

        fixedCount++;
      }
    }

    // Also fix orders where price > 0 but total doesn't include options
    const addOnBroken = await this.dataSource.query(`
      SELECT op.order_product_id, op.order_id, op.quantity, op.price, op.total,
        COALESCE((
          SELECT SUM(opo.option_price * opo.option_quantity)
          FROM order_product_option opo
          WHERE opo.order_product_id = op.order_product_id
        ), 0) as options_total
      FROM order_product op
      WHERE op.price > 0
        AND op.total = op.price * op.quantity
        AND EXISTS (
          SELECT 1 FROM order_product_option opo
          WHERE opo.order_product_id = op.order_product_id AND opo.option_price > 0
        )
    `);

    for (const row of addOnBroken) {
      const correctTotal = (parseFloat(row.price) * parseInt(row.quantity)) + parseFloat(row.options_total);
      if (Math.abs(correctTotal - parseFloat(row.total)) > 0.01) {
        await this.dataSource.query(`
          UPDATE order_product SET total = $1 WHERE order_product_id = $2
        `, [correctTotal, row.order_product_id]);
        fixedCount++;
      }
    }

    return {
      message: `Fixed ${fixedCount} order products (${brokenProducts.length} variant, ${addOnBroken.length} add-on checked)`,
      variant_products_found: brokenProducts.length,
      addon_products_checked: addOnBroken.length,
      total_fixed: fixedCount,
    };
  }

  async getStats(): Promise<any> {
    // Get stats for orders from today to future, excluding completed orders
    // Includes both regular orders and subscriptions (standing_order > 0)
    const statsQuery = `
      SELECT
        COUNT(*) as total_orders,
        COUNT(CASE WHEN order_status::int = 1 THEN 1 END) as new_orders,
        COUNT(CASE WHEN order_status::int = 4 THEN 1 END) as pending_approval,
        COUNT(CASE WHEN order_status::int = 7 THEN 1 END) as approved,
        COUNT(CASE WHEN order_status::int = 2 THEN 1 END) as paid_orders
      FROM orders
      WHERE order_status::int NOT IN (0, 8)
      AND (is_completed IS NULL OR is_completed::int = 0)
      -- Removed restrictive date filters to include overdue/late orders in stats
    `;

    const statsResult = await this.dataSource.query(statsQuery);
    const stats = statsResult[0];

    const deliveriesTodayResult = await this.dataSource.query(`
      SELECT COUNT(*) as deliveries_today
      FROM orders
      WHERE order_status::int NOT IN (0, 8)
      AND order_status::int NOT IN (1, 9)
      AND (is_completed IS NULL OR is_completed::int = 0)
      AND (
        (delivery_date_time IS NOT NULL AND DATE(delivery_date_time) = CURRENT_DATE)
        OR (delivery_date_time IS NULL AND DATE(date_added) = CURRENT_DATE)
      )
    `);

    const productionResult = await this.dataSource.query(`
      SELECT COUNT(*) as production_orders
      FROM orders
      WHERE order_status::int = 7
      AND (is_completed IS NULL OR is_completed::int = 0)
    `);

    const revenueResult = await this.dataSource.query(`
      SELECT COALESCE(SUM(order_total), 0) as total_revenue
      FROM orders
      WHERE order_status::int IN (2, 7)
    `);

    const todayResult = await this.dataSource.query(`
      SELECT COUNT(*) as today_orders
      FROM orders
      WHERE order_status::int NOT IN (0, 8)
      AND (is_completed IS NULL OR is_completed::int = 0)
      AND (
        DATE(date_added) = CURRENT_DATE
        OR (delivery_date_time IS NOT NULL AND DATE(delivery_date_time) >= CURRENT_DATE)
        OR (delivery_date_time IS NOT NULL AND DATE(delivery_date_time) < CURRENT_DATE) -- Include late orders
      )
    `);

    // Get all orders from today to future (including subscriptions) - not completed
    // This includes both regular orders and subscription orders (standing_order > 0)
    // Excludes: cancelled (0), deleted (8), and completed orders (is_completed = 1)
    // Shows: ALL orders from today onwards (by delivery date OR creation date)
    const todayOrdersQuery = `
      SELECT 
        o.order_id,
        o.order_total,
        o.order_status,
        o.delivery_date_time,
        o.date_added,
        o.is_completed,
        o.customer_order_name,
        o.customer_from as order_made_from,
        o.standing_order,
        COALESCE(o.packaging_status, 0) as packaging_status,
        c.firstname,
        c.lastname,
        c.email,
        c.telephone
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      WHERE o.order_status::int NOT IN (0, 8)
      AND (o.is_completed IS NULL OR o.is_completed::int = 0)
      ORDER BY 
        CASE WHEN o.standing_order > 0 THEN 0 ELSE 1 END,
        CASE 
          WHEN o.delivery_date_time IS NOT NULL THEN o.delivery_date_time
          ELSE o.date_added
        END ASC,
        o.date_added DESC
      LIMIT 200
    `;
    const todayOrdersResult = await this.dataSource.query(todayOrdersQuery);
    const todayOrders = todayOrdersResult.map((row: any) => ({
      order_id: row.order_id,
      customer_order_name: row.customer_order_name || `${row.firstname || ''} ${row.lastname || ''}`.trim() || 'N/A',
      order_total: parseFloat(row.order_total || 0),
      order_status: row.order_status,
      date_added: row.date_added,
      delivery_date_time: row.delivery_date_time,
      delivery_date: row.delivery_date_time ? new Date(row.delivery_date_time).toISOString().split('T')[0] : null,
      delivery_time: row.delivery_date_time ? new Date(row.delivery_date_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : null,
      is_completed: row.is_completed || 0,
      standing_order: row.standing_order || 0,
      order_made_from: row.order_made_from,
      packaging_status: parseInt(row.packaging_status) || 0,
      customer: {
        firstname: row.firstname,
        lastname: row.lastname,
        email: row.email,
        telephone: row.telephone,
      },
    }));

    // Get tomorrow's delivery orders - filter out completed
    // Includes both regular orders and subscriptions
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0); // Set to start of day for accurate comparison
    const tomorrowDateStr = tomorrow.toISOString().split('T')[0];
    const tomorrowStart = tomorrow.toISOString();
    const tomorrowEnd = new Date(tomorrow);
    tomorrowEnd.setHours(23, 59, 59, 999);
    const tomorrowEndStr = tomorrowEnd.toISOString();

    const tomorrowOrdersQuery = `
      SELECT 
        o.order_id,
        o.order_total,
        o.order_status,
        o.delivery_date_time,
        o.date_added,
        o.is_completed,
        o.customer_order_name,
        o.customer_from as order_made_from,
        o.standing_order,
        c.firstname,
        c.lastname,
        c.email,
        c.telephone
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      WHERE o.order_status::int NOT IN (0, 8)
      AND (o.is_completed IS NULL OR o.is_completed::int = 0)
      AND o.delivery_date_time IS NOT NULL
      AND o.delivery_date_time >= $1::timestamp
      AND o.delivery_date_time < $2::timestamp
      ORDER BY 
        CASE WHEN o.standing_order > 0 THEN 0 ELSE 1 END,
        o.delivery_date_time ASC,
        o.date_added DESC
      LIMIT 50
    `;
    const tomorrowOrdersResult = await this.dataSource.query(tomorrowOrdersQuery, [tomorrowStart, tomorrowEndStr]);
    const tomorrowOrders = tomorrowOrdersResult.map((row: any) => ({
      order_id: row.order_id,
      customer_order_name: row.customer_order_name || `${row.firstname || ''} ${row.lastname || ''}`.trim() || 'N/A',
      order_total: parseFloat(row.order_total || 0),
      order_status: row.order_status,
      date_added: row.date_added,
      delivery_date_time: row.delivery_date_time,
      delivery_date: row.delivery_date_time ? new Date(row.delivery_date_time).toISOString().split('T')[0] : null,
      delivery_time: row.delivery_date_time ? new Date(row.delivery_date_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : null,
      is_completed: row.is_completed || 0,
      standing_order: row.standing_order || 0,
      order_made_from: row.order_made_from,
      customer: {
        firstname: row.firstname,
        lastname: row.lastname,
        email: row.email,
        telephone: row.telephone,
      },
    }));

    // Get next 7 days orders - filter out completed
    // Includes both regular orders and subscriptions
    const next7DaysStart = new Date();
    next7DaysStart.setDate(next7DaysStart.getDate() + 2);
    const next7DaysEnd = new Date();
    next7DaysEnd.setDate(next7DaysEnd.getDate() + 7);
    const next7DaysStartStr = next7DaysStart.toISOString().split('T')[0];
    const next7DaysEndStr = next7DaysEnd.toISOString().split('T')[0];

    const next7DaysOrdersQuery = `
      SELECT 
        o.order_id,
        o.order_total,
        o.order_status,
        o.delivery_date_time,
        o.date_added,
        o.is_completed,
        o.customer_order_name,
        o.customer_from as order_made_from,
        o.standing_order,
        c.firstname,
        c.lastname,
        c.email,
        c.telephone
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      WHERE o.order_status::int NOT IN (0, 8)
      AND (o.is_completed IS NULL OR o.is_completed::int = 0)
      AND o.delivery_date_time IS NOT NULL
      AND DATE(o.delivery_date_time) >= $1
      AND DATE(o.delivery_date_time) <= $2
      ORDER BY 
        CASE WHEN o.standing_order > 0 THEN 0 ELSE 1 END,
        o.delivery_date_time ASC,
        o.date_added DESC
      LIMIT 100
    `;
    const next7DaysOrdersResult = await this.dataSource.query(next7DaysOrdersQuery, [next7DaysStartStr, next7DaysEndStr]);
    const next7DaysOrders = next7DaysOrdersResult.map((row: any) => ({
      order_id: row.order_id,
      customer_order_name: row.customer_order_name || `${row.firstname || ''} ${row.lastname || ''}`.trim() || 'N/A',
      order_total: parseFloat(row.order_total || 0),
      order_status: row.order_status,
      date_added: row.date_added,
      delivery_date_time: row.delivery_date_time,
      delivery_date: row.delivery_date_time ? new Date(row.delivery_date_time).toISOString().split('T')[0] : null,
      delivery_time: row.delivery_date_time ? new Date(row.delivery_date_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : null,
      is_completed: row.is_completed || 0,
      standing_order: row.standing_order || 0,
      order_made_from: row.order_made_from,
      customer: {
        firstname: row.firstname,
        lastname: row.lastname,
        email: row.email,
        telephone: row.telephone,
      },
    }));

    // Get recent orders (last 10) - filter out completed
    // Includes both regular orders and subscriptions
    // Shows orders from today to future
    const recentOrdersQuery = `
      SELECT 
        o.order_id,
        o.order_total,
        o.order_status,
        o.delivery_date_time,
        o.date_added,
        o.is_completed,
        o.customer_order_name,
        o.customer_from as order_made_from,
        o.standing_order,
        c.firstname,
        c.lastname,
        c.email,
        c.telephone
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      WHERE o.order_status::int NOT IN (0, 8)
      AND (o.is_completed IS NULL OR o.is_completed::int = 0)
      AND (
        o.delivery_date_time >= CURRENT_DATE
        OR o.delivery_date_time IS NULL
        OR DATE(o.date_added) >= CURRENT_DATE
      )
      ORDER BY 
        CASE WHEN o.standing_order > 0 THEN 0 ELSE 1 END,
        o.date_added DESC
      LIMIT 10
    `;
    const recentOrdersResult = await this.dataSource.query(recentOrdersQuery);
    const recentOrders = recentOrdersResult.map((row: any) => ({
      order_id: row.order_id,
      customer_order_name: row.customer_order_name || `${row.firstname || ''} ${row.lastname || ''}`.trim() || 'N/A',
      order_total: parseFloat(row.order_total || 0),
      order_status: row.order_status,
      date_added: row.date_added,
      delivery_date_time: row.delivery_date_time,
      delivery_date: row.delivery_date_time ? new Date(row.delivery_date_time).toISOString().split('T')[0] : null,
      delivery_time: row.delivery_date_time ? new Date(row.delivery_date_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : null,
      is_completed: row.is_completed || 0,
      standing_order: row.standing_order || 0,
      order_made_from: row.order_made_from,
      customer: {
        firstname: row.firstname,
        lastname: row.lastname,
        email: row.email,
        telephone: row.telephone,
      },
    }));

    return {
      stats: {
        totalOrders: parseInt(stats.total_orders) || 0,
        newOrders: parseInt(stats.new_orders) || 0,
        pendingApproval: parseInt(stats.pending_approval) || 0,
        approved: parseInt(stats.approved) || 0,
        completed: parseInt(stats.paid_orders) || 0,
        todayOrders: parseInt(todayResult[0]?.today_orders) || 0,
        totalRevenue: parseFloat(revenueResult[0]?.total_revenue) || 0,
        deliveriesToday: parseInt(deliveriesTodayResult[0]?.deliveries_today) || 0,
        productionOrders: parseInt(productionResult[0]?.production_orders) || 0,
      },
      todayOrders,
      tomorrowOrders,
      next7DaysOrders,
      recentOrders,
    };
  }

  async getStDruexOrders(query: any): Promise<any> {
    const {
      limit = 50,
      offset = 0,
      status,
      search,
      past = false,
    } = query;

    const params: any[] = [];
    let paramIndex = 1;

    // Query for St Druex orders (company name contains "St Druex" or "St. Druex" or similar)
    let sqlQuery = `
      SELECT 
        o.order_id,
        o.order_total,
        o.order_status,
        o.delivery_date_time,
        o.date_added,
        o.order_comments,
        o.shipping_address_1,
        o.is_completed,
        o.payment_status,
        c.firstname,
        c.lastname,
        c.email,
        c.telephone,
        co.company_name,
        l.location_name,
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'product_id', op.product_id,
              'product_name', COALESCE(p.product_name, 'Unknown Product'),
              'quantity', op.quantity,
              'price', op.price,
              'total', op.total
            ) ORDER BY op.order_product_id
          )
          FROM order_product op
          LEFT JOIN product p ON op.product_id = p.product_id
          WHERE op.order_id = o.order_id
        ), '[]'::json) as products,
        CASE 
          WHEN EXISTS (
            SELECT 1 FROM payment_history ph 
            WHERE ph.order_id = o.order_id 
            AND ph.payment_status = 'succeeded'
          ) THEN true
          ELSE false
        END as has_successful_payment
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      LEFT JOIN company co ON c.company_id = co.company_id
      LEFT JOIN locations l ON o.location_id = l.location_id
      WHERE 1=1
      AND (
        co.company_name ILIKE '%St Druex%' 
        OR co.company_name ILIKE '%St. Druex%'
        OR co.company_name ILIKE '%StDruex%'
        OR o.customer_company_name ILIKE '%St Druex%'
        OR o.customer_company_name ILIKE '%St. Druex%'
        OR o.customer_company_name ILIKE '%StDruex%'
      )
    `;

    // Filter by completion status
    if (past) {
      // Show completed orders (status 7 or is_completed = 1)
      sqlQuery += ` AND (o.order_status = 7 OR o.is_completed = 1)`;
    } else {
      // Show non-completed orders (not status 7 and is_completed != 1)
      sqlQuery += ` AND o.order_status != 7 AND (o.is_completed IS NULL OR o.is_completed != 1)`;
    }

    // Filter by status if provided
    if (status !== undefined) {
      sqlQuery += ` AND o.order_status = $${paramIndex++}`;
      params.push(Number(status));
    }

    // Search filter
    if (search) {
      sqlQuery += ` AND (
        CAST(o.order_id AS TEXT) ILIKE $${paramIndex} OR
        c.firstname ILIKE $${paramIndex} OR
        c.lastname ILIKE $${paramIndex} OR
        CONCAT(c.firstname, ' ', c.lastname) ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Get total count
    const countQuery = `SELECT COUNT(*) FROM (${sqlQuery}) as count_query`;
    const countResult = await this.dataSource.query(countQuery, params);
    const count = parseInt(countResult[0].count);

    // Add ordering and pagination - latest orders first
    sqlQuery += ` ORDER BY o.date_added DESC, o.delivery_date_time DESC NULLS LAST LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await this.dataSource.query(sqlQuery, params);

    // Parse products JSON
    const orders = result.map((row: any) => {
      const products = typeof row.products === 'string' ? JSON.parse(row.products) : row.products || [];

      // Extract suburb and postcode from shipping address
      const address = row.shipping_address_1 || '';
      const addressParts = address.split(',').map((p: string) => p.trim());
      let suburb = '';
      let postcode = '';

      // Try to extract postcode (usually last part)
      const postcodeMatch = address.match(/\b\d{4}\b/);
      if (postcodeMatch) {
        postcode = postcodeMatch[0];
        const postcodeIndex = addressParts.findIndex((p: string) => p.includes(postcode));
        if (postcodeIndex > 0) {
          suburb = addressParts[postcodeIndex - 1];
        }
      }

      // Determine payment status
      // Check if there's a successful payment in payment_history OR order_status is 2 (Paid)
      let paymentStatus = 'Not Paid';
      const hasSuccessfulPayment = row.has_successful_payment || false;
      if (row.payment_status === 'succeeded' || hasSuccessfulPayment || row.order_status === 2) {
        paymentStatus = 'Paid';
      } else if (row.payment_status === 'pay_later') {
        paymentStatus = 'Pay Later';
      } else if (row.order_status === 7 || row.order_status === 5 || row.is_completed === 1) {
        paymentStatus = 'Completed';
      }

      // Calculate summary
      const productCount = products.length;
      const productSummary = products.map((p: any) => `${p.product_name} (Qty: ${p.quantity})`).join(', ');

      return {
        order_id: row.order_id,
        customer_name: `${row.firstname || ''} ${row.lastname || ''}`.trim() || 'N/A',
        suburb_postcode: suburb && postcode ? `${suburb} ${postcode}` : (address || 'N/A'),
        suburb,
        postcode,
        address: row.shipping_address_1,
        status: paymentStatus,
        order_status: row.order_status,
        is_completed: row.is_completed || 0,
        notes: row.order_comments || '',
        order_total: parseFloat(row.order_total || 0),
        delivery_date_time: row.delivery_date_time,
        date_added: row.date_added,
        products,
        product_count: productCount,
        product_summary: productSummary,
        company_name: row.company_name,
        location_name: row.location_name,
      };
    });

    return {
      orders,
      count,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  async updateOrderNotes(id: number, notes: string, weight?: number): Promise<any> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Check if order exists
      const checkResult = await queryRunner.query(`SELECT order_id FROM orders WHERE order_id = $1`, [id]);
      if (checkResult.length === 0) {
        throw new NotFoundException('Order not found');
      }

      // Update order comments (notes)
      const updateQuery = `
        UPDATE orders 
        SET order_comments = $1,
            date_modified = NOW()
        WHERE order_id = $2
        RETURNING order_id, order_comments
      `;

      const result = await queryRunner.query(updateQuery, [notes, id]);

      await queryRunner.commitTransaction();

      return {
        order_id: result[0].order_id,
        notes: result[0].order_comments,
        weight: weight || null,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Update order notes error:', error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async sendEmail(id: number, emailType: string = 'order_confirmation', customMessage?: string, recipientEmailOverride?: string): Promise<any> {
    const orderData = await this.findOne(id);
    const order = orderData.order;

    // Use override email if provided (from "Send to Customer" modal), otherwise fall back to stored customer email
    const recipientEmail = recipientEmailOverride || order.customer_order_email || order.email || order.customer_email;

    if (!recipientEmail) {
      throw new BadRequestException('Customer email not found');
    }

    // Generate invoice PDF buffer for attachment
    const invoicePdfBuffer = await this.invoiceService.generatePDFBuffer(id);
    const companyName = this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee';
    const companyPhone = this.configService.get<string>('COMPANY_PHONE') || '';
    const companyEmail = this.configService.get<string>('COMPANY_EMAIL') || '';

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; background-color: #ffffff; }
    .header { background-color: #2952E6; color: white; padding: 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; color: #ffffff; }
    .content { padding: 30px 20px; }
    .footer { padding: 20px; text-align: center; font-size: 12px; color: #777; border-top: 1px solid #eee; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>${companyName}</h1></div>
    <div class="content">
      <h2 style="color: #333; margin-top: 0;">Order Confirmation #${order.order_id}</h2>
      <p>Dear ${order.customer_order_name},</p>
      <p>Thank you for your order!</p>
      ${customMessage ? `<p>${customMessage}</p>` : ''}
      <p>Please find your invoice attached to this email.</p>
      <p>If you have any questions, please contact us at ${companyPhone} or ${companyEmail}.</p>
      <p>Kind regards,<br/>${companyName} Team</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.
    </div>
  </div>
</body>
</html>`;

    const result = await this.emailService.sendEmail({
      to: recipientEmail,
      subject: `Order Confirmation #${order.order_id} - ${companyName}`,
      html: emailHtml,
      attachments: [
        {
          filename: `invoice-${order.order_id}.pdf`,
          content: invoicePdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    if (!result.success) {
      this.logger.error(`Failed to send order email to ${recipientEmail} for order #${id}: ${result.error || 'Unknown error'}`);
      throw new BadRequestException(`Failed to send email: ${result.error || 'Unknown error'}`);
    }

    this.logger.log(`Order email sent to ${recipientEmail} for order #${id}`);
    return { message: 'Email sent successfully', email_sent: true, sentTo: recipientEmail, sent_to: [recipientEmail], messageId: result.messageId };
  }

  /**
   * Send payment link email to customer
   */
  async sendPaymentLink(id: number): Promise<any> {
    const orderData = await this.findOne(id);
    const order = orderData.order;

    const recipientEmail = order.customer_order_email || order.email || order.customer_email;

    if (!recipientEmail) {
      throw new BadRequestException('Customer email not found');
    }

    // Check if order is already paid
    if (order.order_status === 2 || order.payment_status === 'succeeded' || order.payment_status === 'paid') {
      throw new BadRequestException('Order is already paid');
    }

    const customerName = order.customer_order_name ||
      `${order.firstname || ''} ${order.lastname || ''}`.trim() ||
      'Customer';

    const orderTotal = parseFloat(order.order_total || 0);
    const companyName = this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee';

    // Generate payment link (deep link to payment page)
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') ||
      this.configService.get<string>('STORE_URL') ||
      'http://localhost:3000';
    const paymentLink = `${frontendUrl}/payment?order_id=${id}`;

    // Generate invoice PDF for attachment
    const invoicePdfBuffer = await this.invoiceService.generatePDFBuffer(id);

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 0 auto; background-color: #fff; padding: 20px; }
    .header { background-color: #2952E6; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
    .order-details { background-color: #f9f9f9; padding: 15px; margin: 15px 0; border-radius: 5px; }
    .order-info { margin: 10px 0; }
    .order-info strong { display: inline-block; width: 150px; }
    .amount { font-size: 24px; font-weight: bold; color: #2952E6; margin: 20px 0; }
    .cta-button { display: inline-block; padding: 15px 30px; background-color: #28a745; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; font-size: 16px; font-weight: bold; }
    .cta-button:hover { background-color: #218838; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
    .note { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="color: #ffffff; margin: 0;">Payment Required - Order #${id}</h1>
    </div>
    <div class="content">
      <p>Dear ${customerName},</p>
      <p>Your order #${id} is ready for payment. Please complete your payment to proceed with your order.</p>
      
      <div class="order-details">
        <h3 style="margin-top: 0;">Order Summary</h3>
        <div class="order-info"><strong>Order Number:</strong> #${id}</div>
        <div class="amount">Amount Due: $${orderTotal.toFixed(2)}</div>
        <div class="order-info"><strong>Order Date:</strong> ${new Date(order.date_added || new Date()).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Australia/Sydney' })}</div>
      </div>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${paymentLink}" class="cta-button" style="color: #ffffff !important;">Pay Now</a>
      </div>

      <div class="note">
        <strong>Note:</strong> Payment must be made 7 days from the delivery date. Late payment fees will incur after 21 days.
      </div>

      <p>Your invoice is attached to this email for your records.</p>
      
      <p>If you have any questions or need assistance, please don't hesitate to contact us.</p>
      
      <p>Thank you for your business!</p>
    </div>
    <div class="footer">
      <p>If you have any questions, please contact us.</p>
      <p>&copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `;

    const result = await this.emailService.sendEmail({
      to: recipientEmail,
      subject: `Payment Required - Order #${id} - ${companyName}`,
      html: emailHtml,
      attachments: [
        {
          filename: `invoice-${id}.pdf`,
          content: invoicePdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    if (!result.success) {
      throw new BadRequestException(`Failed to send payment link email: ${result.error}`);
    }

    this.logger.log(`Payment link email sent to ${recipientEmail} for order #${id}`);

    return {
      success: true,
      message: 'Payment link email sent successfully',
      sent_to: [recipientEmail],
      sentTo: recipientEmail,
      paymentLink: paymentLink,
    };
  }
}
