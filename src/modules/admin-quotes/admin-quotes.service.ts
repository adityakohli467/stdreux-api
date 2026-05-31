import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EmailService } from '../../common/services/email.service';
import { InvoiceService } from '../../common/services/invoice.service';
import { NotificationService } from '../../common/services/notification.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminQuotesService {
  private readonly logger = new Logger(AdminQuotesService.name);

  constructor(
    private dataSource: DataSource,
    private emailService: EmailService,
    private invoiceService: InvoiceService,
    private notificationService: NotificationService,
    private configService: ConfigService,
  ) { }

  async findAll(query: any): Promise<any> {
    const { limit = 20, offset = 0, search, status, customer_id, location_id, date_from, date_to } = query;

    let sqlQuery = `
      SELECT 
        o.order_id,
        o.customer_id,
        o.order_status,
        o.order_total,
        o.delivery_fee,
        o.date_added,
        o.date_modified,
        o.delivery_date_time,
        TO_CHAR(o.delivery_date_time, 'YYYY-MM-DD') as db_delivery_date,
        TO_CHAR(o.delivery_date_time, 'HH24:MI') as db_delivery_time,
        o.delivery_address,
        o.delivery_method,
        o.approval_comments,
        o.customer_order_name,
        o.coupon_id,
        o.coupon_discount as stored_coupon_discount,
        c.firstname,
        c.lastname,
        c.email,
        c.telephone,
        c.customer_type,
        co.company_name,
        l.location_name,
        d.department_name,
        cp.coupon_code,
        cp.type as coupon_type,
        cp.coupon_discount
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      LEFT JOIN company co ON c.company_id = co.company_id
      LEFT JOIN locations l ON o.location_id = l.location_id
      LEFT JOIN department d ON c.department_id = d.department_id
      LEFT JOIN coupon cp ON o.coupon_id = cp.coupon_id
      WHERE o.standing_order = 0
      AND o.order_status::int IN (0, 4, 7, 8, 9) -- Include Draft, Sent, Approved, Rejected, and Modified
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      sqlQuery += ` AND (c.firstname ILIKE $${paramIndex} OR c.lastname ILIKE $${paramIndex} OR o.customer_order_name ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (status !== undefined) {
      sqlQuery += ` AND o.order_status::int = $${paramIndex}`;
      params.push(Number(status));
      paramIndex++;
    }

    if (customer_id) {
      sqlQuery += ` AND o.customer_id = $${paramIndex}`;
      params.push(Number(customer_id));
      paramIndex++;
    }

    if (location_id) {
      sqlQuery += ` AND o.location_id = $${paramIndex}`;
      params.push(Number(location_id));
      paramIndex++;
    }

    if (date_from) {
      sqlQuery += ` AND o.date_added >= $${paramIndex}`;
      params.push(date_from);
      paramIndex++;
    }

    if (date_to) {
      sqlQuery += ` AND o.date_added <= $${paramIndex}`;
      params.push(`${date_to} 23:59:59`);
      paramIndex++;
    }

    const countResult = await this.dataSource.query(`SELECT COUNT(*) FROM (${sqlQuery}) as count_query`, params);
    const count = parseInt(countResult[0].count);

    sqlQuery += ` ORDER BY o.date_added DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await this.dataSource.query(sqlQuery, params);

    const quoteIds = result.map((row: any) => row.order_id);
    const productsMap = new Map();

    if (quoteIds.length > 0) {
      const productsResult = await this.dataSource.query(`
        SELECT op.order_id, op.total
        FROM order_product op
        WHERE op.order_id = ANY($1)
      `, [quoteIds]);

      productsResult.forEach((row: any) => {
        const current = productsMap.get(row.order_id) || 0;
        productsMap.set(row.order_id, current + parseFloat(row.total || 0));
      });
    }

    const quotes = result.map((row: any) => {
      const subtotal = productsMap.get(row.order_id) || 0;
      // GST is 10% of subtotal (Tax Exclusive logic)
      const gst = Math.round((subtotal * 0.1) * 100) / 100;
      const orderTotal = parseFloat(row.order_total || 0);

      let statusLabel = 'Quote';
      if (row.order_status === 4) statusLabel = 'Sent';
      else if (row.order_status === 7) statusLabel = 'Approved';
      else if (row.order_status === 8) statusLabel = 'Rejected';
      else if (row.order_status === 9) statusLabel = 'Modify';

      // Add delivery helper fields to match findOne
      let delivery_date: string | null = null;
      let delivery_time: string | null = null;
      if (row.delivery_date_time) {
        delivery_date = row.db_delivery_date;
        delivery_time = row.db_delivery_time;
      }

      return {
        ...row,
        order_total: orderTotal,
        gst: gst,
        status: statusLabel,
        delivery_date,
        delivery_time,
      };
    });

    return {
      quotes,
      count,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  async findOne(id: number): Promise<any> {
    const query = `
      SELECT o.*, 
      TO_CHAR(o.delivery_date_time, 'YYYY-MM-DD') as db_delivery_date,
      TO_CHAR(o.delivery_date_time, 'HH24:MI') as db_delivery_time,
      c.firstname, c.lastname, c.email, c.telephone, co.company_name, d.department_name, l.location_name,
      (SELECT json_agg(json_build_object(
        'product_id', op.product_id, 
        'product_name', p.product_name, 
        'quantity', op.quantity, 
        'price', op.price, 
        'total', op.total,
        'options', (
          SELECT json_agg(json_build_object(
            'option_name', opo.option_name,
            'option_value', opo.option_value,
            'option_quantity', opo.option_quantity,
            'option_price', opo.option_price
          )) FROM order_product_option opo WHERE opo.order_product_id = op.order_product_id
        )
      )) FROM order_product op LEFT JOIN product p ON op.product_id = p.product_id WHERE op.order_id = o.order_id) as products
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      LEFT JOIN company co ON c.company_id = co.company_id
      LEFT JOIN department d ON c.department_id = d.department_id
      LEFT JOIN locations l ON o.location_id = l.location_id
      WHERE o.order_id = $1 AND o.standing_order = 0
    `;
    const result = await this.dataSource.query(query, [id]);
    if (result.length === 0) throw new NotFoundException('Quote not found');
    const quote = result[0];
    const subtotal = quote.products.reduce((acc: number, p: any) => acc + parseFloat(p.total || 0), 0);
    // GST is 10% of subtotal (Tax Exclusive logic)
    quote.gst = Math.round((subtotal * 0.1) * 100) / 100;
    quote.calculated_total = parseFloat(quote.order_total || 0);

    // Add delivery helper fields
    if (quote.delivery_date_time) {
      quote.selected_date = quote.db_delivery_date;
      quote.selected_time = quote.db_delivery_time;
      quote.delivery_date = quote.selected_date;
      quote.delivery_time = quote.selected_time;
    } else {
      quote.selected_date = null;
      quote.selected_time = null;
      quote.delivery_date = null;
      quote.delivery_time = null;
    }

    return { quote };
  }

  async create(createQuoteDto: any, userId: number): Promise<any> {
    return this.dataSource.transaction(async (manager) => {
      const {
        customer_id,
        location_id,
        products,
        delivery_fee = 0,
        delivery_date,
        delivery_time,
        delivery_address,
        delivery_contact,
        delivery_phone,
        order_comments
      } = createQuoteDto;

      let subtotal = 0;
      for (const product of products) {
        const productPrice = parseFloat(product.price) || 0;
        const qty = parseInt(product.quantity) || 1;
        let optionsTotal = 0;
        const options = product.options || product.add_ons || [];
        
        if (Array.isArray(options)) {
          for (const addon of options) {
            optionsTotal += (parseFloat(addon.option_price) || 0) * (parseInt(addon.option_quantity) || qty);
          }
        }
        
        subtotal += (productPrice * qty) + optionsTotal;
      }
      const orderTotal = Math.round((subtotal + parseFloat(delivery_fee)) * 100) / 100;

      // Handle delivery date time
      let deliveryDateTime: Date | null = null;
      if (delivery_date) {
        const timePart = delivery_time || '00:00';
        deliveryDateTime = new Date(`${delivery_date}T${timePart.includes(':') ? timePart : timePart + ':00'}`);
      }

      const orderResult = await manager.query(
        `INSERT INTO orders (
          customer_id, location_id, branch_id, shipping_method, order_status, 
          order_total, delivery_fee, standing_order, user_id, 
          date_added, date_modified, delivery_date_time, delivery_address, 
          delivery_contact, delivery_phone, order_comments
        )
        VALUES ($1, $2, 1, 1, 0, $3, $4, 0, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $6, $7, $8, $9, $10) 
        RETURNING order_id`,
        [
          customer_id,
          location_id || 1,
          orderTotal,
          delivery_fee,
          userId,
          deliveryDateTime,
          delivery_address || null,
          delivery_contact || null,
          delivery_phone || null,
          order_comments || null
        ]
      );
      const orderId = orderResult[0].order_id;
      for (let i = 0; i < products.length; i++) {
        const product = products[i];
        const productPrice = parseFloat(product.price || 0);
        const qty = parseInt(product.quantity || 1);
        const productOptions = product.options || product.add_ons || [];
        let productOptionsTotal = 0;
        if (Array.isArray(productOptions)) {
          for (const opt of productOptions) {
            productOptionsTotal += (parseFloat(opt.option_price) || 0) * (parseInt(opt.option_quantity) || qty);
          }
        }
        const productTotal = (productPrice * qty) + productOptionsTotal;
        
        const orderProductResult = await manager.query(
          `INSERT INTO order_product (order_id, product_id, quantity, price, total, sort_order) VALUES ($1, $2, $3, $4, $5, $6) RETURNING order_product_id`,
          [orderId, product.product_id, product.quantity, product.price, productTotal, i + 1]
        );
        const orderProductId = orderProductResult[0].order_product_id;

        // Save options
        const options = product.options || product.add_ons || [];
        if (Array.isArray(options)) {
          for (const option of options) {
            const optQty = parseInt(option.option_quantity) || qty;
            const optPrice = parseFloat(option.option_price) || 0;
            await manager.query(
              `INSERT INTO order_product_option (
                order_id, order_product_id, product_option_id, option_name, option_value,
                option_quantity, option_price, option_total
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                orderId,
                orderProductId,
                option.product_option_id || option.option_value_id || 0,
                option.option_name || '',
                option.option_value || '',
                optQty,
                optPrice,
                optPrice * optQty
              ]
            );
          }
        }
      }
      return { quote: { order_id: orderId, order_total: orderTotal } };
    });
  }

  async update(id: number, updateQuoteDto: any, userId: number): Promise<any> {
    return this.dataSource.transaction(async (manager) => {
      const {
        customer_id,
        location_id,
        products = [],
        delivery_fee = 0,
        order_status,
        delivery_date,
        delivery_time,
        delivery_address,
        delivery_contact,
        delivery_phone,
        order_comments
      } = updateQuoteDto;

      let subtotal = 0;
      for (const product of products) {
        const productPrice = parseFloat(product.price) || 0;
        const qty = parseInt(product.quantity) || 1;
        let optionsTotal = 0;
        const options = product.options || product.add_ons || [];
        
        if (Array.isArray(options)) {
          for (const addon of options) {
            optionsTotal += (parseFloat(addon.option_price) || 0) * (parseInt(addon.option_quantity) || qty);
          }
        }
        
        subtotal += (productPrice * qty) + optionsTotal;
      }
      const orderTotal = Math.round((subtotal + parseFloat(delivery_fee)) * 100) / 100;

      // Handle delivery date time
      let deliveryDateTime: Date | null = null;
      if (delivery_date) {
        const timePart = delivery_time || '00:00';
        deliveryDateTime = new Date(`${delivery_date}T${timePart.includes(':') ? timePart : timePart + ':00'}`);
      }

      await manager.query(
        `UPDATE orders SET 
          customer_id = $1, 
          location_id = $2, 
          order_total = $3, 
          delivery_fee = $4, 
          order_status = $5, 
          date_modified = CURRENT_TIMESTAMP, 
          delivery_date_time = $6, 
          delivery_address = $7, 
          delivery_contact = $8, 
          delivery_phone = $9, 
          order_comments = $10 
        WHERE order_id = $11`,
        [
          customer_id,
          location_id || 1,
          orderTotal,
          delivery_fee,
          order_status || 0,
          deliveryDateTime,
          delivery_address || null,
          delivery_contact || null,
          delivery_phone || null,
          order_comments || null,
          id
        ]
      );

      // Clear existing products and options
      await manager.query(`DELETE FROM order_product_option WHERE order_id = $1`, [id]);
      await manager.query(`DELETE FROM order_product WHERE order_id = $1`, [id]);

      // Save new products and options
      for (let i = 0; i < products.length; i++) {
        const product = products[i];
        const productPrice = parseFloat(product.price || 0);
        const qty = parseInt(product.quantity || 1);
        const productOptions = product.options || product.add_ons || [];
        let productOptionsTotal = 0;
        if (Array.isArray(productOptions)) {
          for (const opt of productOptions) {
            productOptionsTotal += (parseFloat(opt.option_price) || 0) * (parseInt(opt.option_quantity) || qty);
          }
        }
        const productTotal = (productPrice * qty) + productOptionsTotal;
        
        const orderProductResult = await manager.query(
          `INSERT INTO order_product (order_id, product_id, quantity, price, total, sort_order) VALUES ($1, $2, $3, $4, $5, $6) RETURNING order_product_id`,
          [id, product.product_id, qty, productPrice, productTotal, i + 1]
        );
        const orderProductId = orderProductResult[0].order_product_id;

        // Save options
        const options = product.options || product.add_ons || [];
        if (Array.isArray(options)) {
          for (const option of options) {
            const optQty = parseInt(option.option_quantity) || qty;
            const optPrice = parseFloat(option.option_price) || 0;
            await manager.query(
              `INSERT INTO order_product_option (
                order_id, order_product_id, product_option_id, option_name, option_value,
                option_quantity, option_price, option_total
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                id,
                orderProductId,
                option.product_option_id || option.option_value_id || 0,
                option.option_name || '',
                option.option_value || '',
                optQty,
                optPrice,
                optPrice * optQty
              ]
            );
          }
        }
      }
      return this.findOne(id);
    });
  }

  async convertToOrder(id: number): Promise<any> {
    await this.dataSource.query(`UPDATE orders SET order_status = 1, date_modified = CURRENT_TIMESTAMP WHERE order_id = $1`, [id]);
    return { success: true };
  }

  async delete(id: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`DELETE FROM order_product WHERE order_id = $1`, [id]);
      await manager.query(`DELETE FROM orders WHERE order_id = $1`, [id]);
    });
  }

  async sendEmail(id: number, recipientEmail?: string, customMessage?: string): Promise<any> {
    const { quote } = await this.findOne(id);
    const recipient = recipientEmail || quote.email;
    if (!recipient) throw new BadRequestException('No recipient email');

    const companyName = this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee';
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const loginUrl = `${frontendUrl}/auth/login`;
    const quoteUrl = `${frontendUrl}/quote/${id}`; // Link to the quote detail page on frontend
    const contactNumber = this.configService.get<string>('COMPANY_PHONE') || '';
    const contactEmail = this.configService.get<string>('COMPANY_EMAIL') || '';

    // Calculate subtotal and details
    const products = quote.products || [];
    let subtotal = 0;
    products.forEach((p: any) => {
      let productBaseTotal = parseFloat(p.total || 0);
      let optionsTotal = 0;
      if (p.options && Array.isArray(p.options)) {
        p.options.forEach((opt: any) => {
          optionsTotal += (parseFloat(opt.option_price || 0) * (parseInt(opt.option_quantity || 1)));
        });
      }
      
      // Check for double counting
      const isDoubleCount = productBaseTotal > 0 && Math.abs(productBaseTotal - optionsTotal) < 0.01;
      subtotal += isDoubleCount ? productBaseTotal : (productBaseTotal + optionsTotal);
    });
    const deliveryFee = parseFloat(quote.delivery_fee || 0);
    const total = parseFloat(quote.order_total || 0);

    // Format Date and Time
    let deliveryDate = 'To be confirmed';
    let deliveryTime = 'To be confirmed';
    if (quote.delivery_date_time) {
      const date = new Date(quote.delivery_date_time);
      deliveryDate = date.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: '2-digit' });
      deliveryTime = date.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
    }

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f7; }
    .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
    .header { background-color: #2952E6; color: #ffffff; padding: 30px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; font-weight: bold; }
    .content { padding: 30px; }
    .section { margin-bottom: 25px; background: #ffffff; border: 1px solid #eaeaef; border-radius: 8px; padding: 20px; }
    .section-title { color: #2952E6; font-size: 18px; font-weight: bold; margin-bottom: 15px; border-bottom: 1px solid #eaeaef; padding-bottom: 8px; }
    .detail-row { display: flex; margin-bottom: 8px; }
    .detail-label { font-weight: bold; width: 140px; color: #666; font-size: 14px; }
    .detail-value { flex: 1; color: #333; font-size: 14px; }
    .table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    .table th { text-align: left; background-color: #f8f9fa; padding: 10px; font-size: 13px; border-bottom: 2px solid #eaeaef; }
    .table td { padding: 10px; border-bottom: 1px solid #f0f0f5; font-size: 14px; }
    .totals { margin-top: 15px; }
    .total-row { display: flex; justify-content: flex-end; padding: 5px 0; }
    .total-label { font-weight: bold; width: 120px; text-align: right; margin-right: 20px; color: #666; }
    .total-value { font-weight: bold; width: 100px; text-align: right; color: #333; }
    .grand-total { border-top: 2px solid #eaeaef; margin-top: 10px; padding-top: 10px; }
    .grand-total .total-value { color: #2952E6; font-size: 18px; }
    .button-container { text-align: center; margin: 35px 0; }
    .button { background-color: #2952E6; color: #ffffff !important; padding: 16px 32px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 16px; transition: background 0.2s; }
    .footer { text-align: center; padding: 25px; color: #9a9ea6; font-size: 12px; background-color: #ffffff; }
    .footer p { margin: 5px 0; }
    a { color: #2952E6; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Quote #${id}</h1>
    </div>
    <div class="content">
      <p>Dear ${quote.firstname || 'Customer'},</p>
      <p>Thank you for your interest. Please review the quote details below for your upcoming order.</p>
      
      ${customMessage ? `<div style="background: #f0f4ff; border-left: 4px solid #2952E6; padding: 15px; margin: 20px 0; font-style: italic;">${customMessage}</div>` : ''}

      <div class="section">
        <div class="section-title">Customer Details</div>
        <div class="detail-row">
          <div class="detail-label">Company:</div>
          <div class="detail-value">${quote.company_name || 'N/A'}</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">Department:</div>
          <div class="detail-value">${quote.department_name || 'N/A'}</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">Contact:</div>
          <div class="detail-value">${quote.firstname} ${quote.lastname}</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">Email:</div>
          <div class="detail-value">${quote.email}</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">Phone:</div>
          <div class="detail-value">${quote.telephone || 'N/A'}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Event Details</div>
        <div class="detail-row">
          <div class="detail-label">Date:</div>
          <div class="detail-value">${deliveryDate}</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">Time:</div>
          <div class="detail-value">${deliveryTime}</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">Address:</div>
          <div class="detail-value">${quote.delivery_address || 'To be confirmed'}</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">On-site Contact:</div>
          <div class="detail-value">${quote.delivery_contact || 'N/A'}</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">Contact Phone:</div>
          <div class="detail-value">${quote.delivery_phone || 'N/A'}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Quote Summary</div>
        <table class="table">
          <thead>
            <tr>
              <th>Item</th>
              <th style="text-align: center;">Qty</th>
              <th style="text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${products.map((p: any) => `
              <tr>
                <td>${p.product_name}</td>
                <td style="text-align: center;">${p.quantity}</td>
                <td style="text-align: right;">$${parseFloat(p.total).toFixed(2)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        
        <div class="totals">
          <div class="total-row">
            <div class="total-label">Subtotal:</div>
            <div class="total-value">$${subtotal.toFixed(2)}</div>
          </div>
          <div class="total-row">
            <div class="total-label">Delivery Fee:</div>
            <div class="total-value">$${deliveryFee.toFixed(2)}</div>
          </div>
          <div class="total-row grand-total">
            <div class="total-label">Total:</div>
            <div class="total-value">$${total.toFixed(2)}</div>
          </div>
        </div>
      </div>

      <div class="button-container">
        <a href="${quoteUrl}" class="button" style="color: #ffffff !important;">
          <span style="color: #ffffff !important;">Review & Approve Quote</span>
        </a>
      </div>

      <p style="font-size: 13px; color: #666; text-align: center;">Alternatively, you can request modifications or reject the quote by clicking the button above.</p>
    </div>
    <div class="footer">
      <p>If you have any questions, please contact us at <a href="mailto:${contactEmail}">${contactEmail}</a> or ${contactNumber}.</p>
      <p>&copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `;

    await this.notificationService.sendNotification({
      templateKey: 'quote_details',
      recipientEmail: recipient,
      recipientName: `${quote.firstname} ${quote.lastname}`,
      customSubject: `Quote #${id} – ${companyName}`,
      customBody: emailHtml,
      variables: {}
    });

    await this.dataSource.query(`UPDATE orders SET order_status = 4 WHERE order_id = $1`, [id]);
    return { success: true };
  }
}
