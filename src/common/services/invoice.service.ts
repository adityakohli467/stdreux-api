import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import { FileStorageService } from './file-storage.service';
import { Order } from '../../entities/Order';

export interface InvoiceData {
  order_id: number;
  order_date: string;
  delivery_date?: string;
  delivery_date_time?: string;
  customer_name: string;
  customer_email?: string;
  customer_phone?: string;
  customer_type?: string;
  company_name?: string;
  department_name?: string;
  location_name?: string;
  location_address?: string;
  location_phone?: string;
  location_email?: string;
  location_abn?: string;
  location_company_name?: string;
  location_account_name?: string;
  location_account_number?: string;
  location_bsb?: string;
  delivery_address?: string;
  items: Array<{
    product_name: string;
    quantity: number;
    price: number;
    total: number;
    is_taxable?: boolean;
    comment?: string;
    options?: Array<{
      option_name: string;
      option_value: string;
      option_quantity: number;
      option_price: number;
    }>;
  }>;
  subtotal: number;
  wholesale_discount?: number;
  delivery_fee: number;
  discount: number;
  gst: number;
  total: number;
  amount_paid: number;
  balance: number;
  order_status: number;
  payment_status: string;
  payment_date?: string;
  order_comments?: string;
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    @InjectRepository(Order)
    private orderRepository: Repository<Order>,
    private dataSource: DataSource,
    private fileStorageService: FileStorageService,
    private configService: ConfigService,
  ) { }

  /**
   * Generate PDF invoice for an order
   */
  async generateInvoice(orderId: number): Promise<string> {
    try {
      const orderData = await this.fetchOrderData(orderId);
      const pdfBuffer = await this.generatePDF(orderData);
      const result = await this.fileStorageService.uploadInvoice(pdfBuffer, orderId);

      // Update order with invoice URL (if column exists)
      try {
        await this.dataSource.query(`UPDATE orders SET invoice_url = $1 WHERE order_id = $2`, [
          result.url,
          orderId,
        ]);
      } catch (error: any) {
        if (error.message && error.message.includes('invoice_url')) {
          this.logger.warn('invoice_url column does not exist, skipping update');
        } else {
          throw error;
        }
      }

      return result.url;
    } catch (error) {
      this.logger.error('Invoice generation error:', error);
      throw new Error(`Failed to generate invoice: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Fetch order data from database
   */
  async fetchOrderData(orderId: number): Promise<InvoiceData> {
    const result = await this.dataSource.query(
      `SELECT 
        o.order_id,
        o.date_added as order_date,
        o.delivery_date_time as delivery_date,
        o.delivery_date_time as delivery_date_time,
        o.delivery_fee,
        o.order_status,
        o.payment_status,
        o.payment_date,
        o.order_comments,
        o.delivery_address,
        o.order_total,
        c.firstname || ' ' || c.lastname as customer_name,
        c.email as customer_email,
        c.telephone as customer_phone,
        c.customer_type,
        comp.company_name,
        comp.company_abn,
        d.department_name,
        loc.location_name,
        loc.pickup_address as location_address,
        loc.contact as location_phone,
        loc.remittance_email as location_email,
        loc.abn as location_abn,
        loc.company_name as location_company_name,
        loc.account_name as location_account_name,
        loc.account_number as location_account_number,
        loc.bsb as location_bsb,
        o.coupon_id,
        o.coupon_discount as stored_coupon_discount,
        cp.coupon_code,
        cp.type as coupon_type,
        cp.coupon_discount,
        o.delivery_method,
        o.delivery_contact,
        o.delivery_details,
        COALESCE((
          SELECT SUM(amount - refund_amount)
          FROM payment_history
          WHERE order_id = o.order_id
          AND payment_status IN ('succeeded', 'paid', 'completed')
        ), 0) as amount_paid
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      LEFT JOIN company comp ON c.company_id = comp.company_id
      LEFT JOIN department d ON c.department_id = d.department_id
      LEFT JOIN locations loc ON o.location_id = loc.location_id
      LEFT JOIN coupon cp ON o.coupon_id = cp.coupon_id
      WHERE o.order_id = $1`,
      [orderId],
    );

    if (result.length === 0) {
      throw new Error(`Order ${orderId} not found`);
    }

    const order = result[0];

    // Fetch order items with categories for GST calculation
    const itemsResult = await this.dataSource.query(
      `SELECT 
        p.product_name,
        op.quantity,
        op.price,
        op.total,
        op.order_product_id,
        op.order_product_comment,
        (
          SELECT string_agg(c.category_name, ',')
          FROM product_category pc
          JOIN category c ON pc.category_id = c.category_id
          WHERE pc.product_id = p.product_id
        ) as category_names,
        (
          SELECT string_agg(CAST(COALESCE(c.gst_free, false) AS TEXT), ',')
          FROM product_category pc
          JOIN category c ON pc.category_id = c.category_id
          WHERE pc.product_id = p.product_id
        ) as gst_free_flags
      FROM order_product op
      LEFT JOIN product p ON op.product_id = p.product_id
      WHERE op.order_id = $1
      ORDER BY op.order_product_id`,
      [orderId],
    );

    // Fetch order product options
    const optionsResult = await this.dataSource.query(
      `SELECT 
        opo.order_product_id,
        opo.option_name,
        opo.option_value,
        opo.option_quantity,
        opo.option_price
      FROM order_product_option opo
      WHERE opo.order_product_id IN (
        SELECT order_product_id FROM order_product WHERE order_id = $1
      )
      ORDER BY opo.order_product_id, opo.order_product_option_id`,
      [orderId],
    );

    // Calculate subtotal and GST for specific categories
    let subtotal = 0;
    let taxableItemsTotal = 0;
    const itemsWithOptions = itemsResult.map((row: any) => {
      const itemTotal = parseFloat(row.total) || 0;
      const productOptions = optionsResult.filter((opt: any) => opt.order_product_id === row.order_product_id);
      
      subtotal += itemTotal;

      // Calculate GST: item is taxable unless its category is marked as gst_free
      const categories = (row.category_names || '').split(',').map((cat: string) => cat.trim().toUpperCase());
      const gstFreeFlags = (row.gst_free_flags || '').split(',').map((flag: string) => flag.trim());
      const isTaxable = !gstFreeFlags.some((flag: string) => flag === 'true' || flag === '1' || flag === 't');
      if (isTaxable) {
        taxableItemsTotal += itemTotal;
      }

      return {
        product_name: row.product_name,
        quantity: parseInt(row.quantity),
        price: parseFloat(row.price),
        total: itemTotal, // Use the total including options
        is_taxable: isTaxable,
        comment: row.order_product_comment || undefined,
        options: productOptions.length > 0 ? productOptions.map((opt: any) => ({
          option_name: opt.option_name,
          option_value: opt.option_value,
          option_quantity: parseInt(opt.option_quantity || 1),
          option_price: parseFloat(opt.option_price || 0),
        })) : undefined,
      };
    });
    const deliveryFee = parseFloat(order.delivery_fee || 0);

    // Calculate wholesale discount - only if explicitly set on the order
    let wholesaleDiscount = 0;
    if (order.wholesale_discount && parseFloat(order.wholesale_discount) > 0) {
      wholesaleDiscount = parseFloat(order.wholesale_discount);
    }

    const afterWholesaleDiscount = subtotal - wholesaleDiscount;

    // Calculate coupon discount
    let couponDiscount = 0;
    if (order.coupon_id) {
      // First, try to use stored coupon_discount from orders table (for historical accuracy)
      if (order.stored_coupon_discount && parseFloat(order.stored_coupon_discount) > 0) {
        couponDiscount = parseFloat(order.stored_coupon_discount);
      } else if (order.coupon_code && order.coupon_discount) {
        // Coupon still exists - calculate from coupon table
        if (order.coupon_type === 'P') {
          couponDiscount = afterWholesaleDiscount * (parseFloat(order.coupon_discount) / 100);
        } else if (order.coupon_type === 'F') {
          couponDiscount = parseFloat(order.coupon_discount);
        }
        couponDiscount = Math.min(couponDiscount, afterWholesaleDiscount);
      } else {
        // Coupon was deleted - calculate from stored order_total
        const tempAfterDiscount = afterWholesaleDiscount;
        const tempGst = 0; // Removed GST
        const tempTotal = tempAfterDiscount + tempGst + deliveryFee;
        const storedTotal = parseFloat(order.order_total || 0);
        if (storedTotal < tempTotal) {
          couponDiscount = tempTotal - storedTotal;
        }
      }
    }

    const afterDiscount = afterWholesaleDiscount - couponDiscount;
    // Determine if wholesale customer - GST is exclusive (added to total)
    // For retail customers, GST is inclusive (already in the price, extract as amount/11)
    const customerType = order.customer_type || '';
    const isWholesale = customerType.includes('Wholesale') || customerType.includes('Wholesaler');
    // Delivery fee is always taxable
    const totalTaxableWithDelivery = taxableItemsTotal + deliveryFee;
    // Retail: GST = amount/11 (extracting from inclusive price)
    // Wholesale: GST = amount * 0.1 (adding on top)
    const gst = isWholesale
      ? Math.round(totalTaxableWithDelivery * 0.1 * 100) / 100
      : Math.round((totalTaxableWithDelivery / 11) * 100) / 100;

    const total = isWholesale
      ? Math.round((afterDiscount + deliveryFee + gst) * 100) / 100
      : Math.round((afterDiscount + deliveryFee) * 100) / 100;

    // Calculate amount paid and balance
    const amountPaid = parseFloat(order.amount_paid || 0);
    // Check payment status: order_status 2 means Paid, OR payment_status is succeeded/paid/completed, OR there's a successful payment in payment_history
    const hasSuccessfulPayment = amountPaid > 0 ||
      order.order_status === 2 ||
      order.payment_status === 'paid' ||
      order.payment_status === 'succeeded' ||
      order.payment_status === 'completed';
    const isPaid = hasSuccessfulPayment;
    const balance = isPaid ? 0 : Math.max(0, total - amountPaid);

    // Determine payment status string
    let paymentStatusStr = 'pending';
    if (hasSuccessfulPayment) {
      paymentStatusStr = 'paid';
    } else if (order.order_status === 1) {
      paymentStatusStr = 'pending';
    } else if (order.order_status === 7) {
      paymentStatusStr = 'completed';
    }

    return {
      order_id: order.order_id,
      order_date: order.order_date,
      delivery_date: order.delivery_date,
      delivery_date_time: order.delivery_date_time,
      customer_name: order.customer_name || 'N/A',
      customer_email: order.customer_email,
      customer_phone: order.customer_phone,
      customer_type: order.customer_type || 'Guest',
      company_name: order.company_name,
      department_name: order.department_name,
      location_name: order.location_name,
      location_address: order.location_address,
      location_phone: order.location_phone,
      location_email: order.location_email,
      location_abn: order.location_abn,
      location_company_name: order.location_company_name,
      location_account_name: order.location_account_name,
      location_account_number: order.location_account_number,
      location_bsb: order.location_bsb,
      delivery_address: order.delivery_address,
      items: itemsWithOptions,
      subtotal,
      wholesale_discount: wholesaleDiscount,
      delivery_fee: deliveryFee,
      discount: couponDiscount,
      gst,
      total,
      amount_paid: amountPaid,
      balance,
      order_status: order.order_status,
      payment_status: paymentStatusStr,
      payment_date: order.payment_date,
      order_comments: order.order_comments,
    };
  }

  /**
   * Get company settings from database
   */
  private async getCompanySettings(): Promise<{
    companyName: string;
    companyEmail: string;
    companyPhone: string;
    companyAbn: string;
  }> {
    try {
      const settingsResult = await this.dataSource.query(
        `SELECT setting_key, setting_value 
         FROM settings 
         WHERE setting_key IN ('company_name', 'company_email', 'company_phone', 'company_abn')`
      );

      const settings: Record<string, string> = {};
      settingsResult.forEach((row: any) => {
        settings[row.setting_key] = row.setting_value;
      });

      return {
        companyName: settings.company_name || this.configService.get<string>('COMPANY_NAME') || 'St. Dreux Coffee',
        companyEmail: settings.company_email || this.configService.get<string>('COMPANY_EMAIL') || 'admin@stdreuxcoffee.com',
        companyPhone: settings.company_phone || this.configService.get<string>('COMPANY_PHONE') || '+61 3 1234 5678',
        companyAbn: settings.company_abn || this.configService.get<string>('COMPANY_ABN') || 'ABN: 12 345 678 901',
      };
    } catch (error) {
      this.logger.warn('Could not fetch company settings from database, using defaults:', error);
      return {
        companyName: this.configService.get<string>('COMPANY_NAME') || 'St. Dreux Coffee',
        companyEmail: this.configService.get<string>('COMPANY_EMAIL') || 'admin@stdreuxcoffee.com',
        companyPhone: this.configService.get<string>('COMPANY_PHONE') || '+61 3 1234 5678',
        companyAbn: this.configService.get<string>('COMPANY_ABN') || 'ABN: 12 345 678 901',
      };
    }
  }

  /**
   * Generate PDF buffer for an order (for email attachments)
   */
  async generatePDFBuffer(orderId: number): Promise<Buffer> {
    const orderData = await this.fetchOrderData(orderId);
    return this.generatePDF(orderData);
  }

  /**
   * Generate PDF document
   */
  private async generatePDF(data: InvoiceData): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
      try {
        // Fetch company settings from database
        const companySettings = await this.getCompanySettings();
        const companyName = companySettings.companyName;

        // Determine if this is a quote or an invoice based on order_status
        const isQuote = data.order_status === 0;
        const documentType = isQuote ? 'Quote' : 'Invoice';
        const documentTypeUpper = isQuote ? 'QUOTE' : 'INVOICE';

        const doc = new PDFDocument({
          margin: 40,
          size: 'A4',
          info: {
            Title: `${documentType} #${data.order_id}`,
            Author: companyName,
            Subject: documentType,
          },
        });
        const buffers: Buffer[] = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
          const pdfBuffer = Buffer.concat(buffers);
          resolve(pdfBuffer);
        });
        doc.on('error', reject);

        // Colors
        const primaryColor = '#0d6efd';
        const darkGray = '#333333';
        const lightGray = '#666666';
        const borderGray = '#e0e0e0';
        const bgGray = '#f8f9fa';

        // Try to load logo
        let logoPath: string | null = null;
        const possibleLogoPaths = [
          path.join(process.cwd(), 'src/assets/logo.png'),
          path.join(process.cwd(), 'dist/assets/logo.png'),
          path.join(__dirname, '../../assets/logo.png'),
          path.join(__dirname, '../../../assets/logo.png'),
        ];

        for (const logo of possibleLogoPaths) {
          try {
            if (fs.existsSync(logo) && fs.statSync(logo).size > 0) {
              logoPath = logo;
              this.logger.log('Logo found at:', logoPath);
              break;
            }
          } catch (error) {
            // Continue to next path
          }
        }

        if (!logoPath) {
          this.logger.warn('Logo not found in any of the expected paths. Invoice will be generated without logo.');
        }

        // Header Section
        const headerY = 15;
        const pageWidth = doc.page.width;
        const pageMargin = 40;
        const pageHeight = doc.page.height;

        // Company Logo
        let logoHeight = 0;
        if (logoPath) {
          try {
            if (logoPath.endsWith('.png') || logoPath.endsWith('.jpg') || logoPath.endsWith('.jpeg')) {
              const logoMaxHeight = 45;
              const logoMaxWidth = 150;
              const logoX = pageMargin;

              doc.image(logoPath, logoX, headerY, {
                width: logoMaxWidth,
                height: logoMaxHeight,
                fit: [logoMaxWidth, logoMaxHeight],
              });
              logoHeight = logoMaxHeight;
            }
          } catch (error) {
            this.logger.warn('Could not load logo image:', error);
            logoPath = null;
          }
        }

        // Company Information - Display in top right corner
        // Use location details if available, otherwise fall back to settings
        const displayCompanyName = data.location_company_name || companyName;
        const displayEmail = data.location_email || companySettings.companyEmail;
        const displayPhone = data.location_phone || companySettings.companyPhone;
        const displayABN = data.location_abn || companySettings.companyAbn;

        doc.fontSize(7).font('Helvetica').fillColor(darkGray);
        const addressStartY = headerY + 1;
        const addressWidth = 170;
        const addressStartX = pageWidth - pageMargin - addressWidth;
        let addressY = addressStartY;

        // Company Name (bold)
        doc.font('Helvetica-Bold').fontSize(8);
        doc.text(displayCompanyName, addressStartX, addressY, { align: 'right', width: addressWidth });
        addressY += 9;

        // Company Email
        doc.font('Helvetica').fontSize(7);
        doc.text(`Email: ${displayEmail}`, addressStartX, addressY, { align: 'right', width: addressWidth });
        addressY += 7;

        // Company Phone
        doc.text(`Phone: ${displayPhone}`, addressStartX, addressY, { align: 'right', width: addressWidth });
        addressY += 7;

        // Company ABN
        doc.text(`ABN: ${displayABN.replace(/^ABN:\s*/i, '')}`, addressStartX, addressY, { align: 'right', width: addressWidth });
        addressY += 7;

        doc.fillColor(darkGray);

        // Document Title Section
        const titleY = Math.max(headerY + logoHeight + 8, addressY + 5);
        doc.rect(40, titleY, 520, 25).fillColor(primaryColor).fill().fillColor('#ffffff');

        doc.fontSize(18).font('Helvetica-Bold').fillColor('#ffffff');
        doc.text(documentTypeUpper, 40, titleY + 7, { width: 520, align: 'center' });

        doc.fillColor(darkGray);

        // Document Details Section
        const detailsY = titleY + 32;
        doc.fontSize(8).font('Helvetica');

        doc.font('Helvetica-Bold').text(`${documentType} Number:`, 40, detailsY);
        doc.font('Helvetica').text(`#${data.order_id}`, 140, detailsY);

        doc.font('Helvetica-Bold').text('Order Date:', 40, detailsY + 9);
        // Format date in Australian timezone (AEST/AEDT)
        const quoteDate = new Date(data.order_date);
        const auDateStr = quoteDate.toLocaleDateString('en-AU', {
          day: '2-digit',
          month: '2-digit',
          year: '2-digit',
          timeZone: 'Australia/Sydney',
        });
        doc.font('Helvetica').text(auDateStr, 130, detailsY + 9);

        // Removed Delivery Date and Time from invoice header as requested

        // Bill To Section
        const billToY = detailsY;
        doc.fontSize(9).font('Helvetica-Bold').fillColor(primaryColor);
        doc.text('Bill To:', 360, billToY);

        doc.rect(355, billToY + 9, 205, 1).fillColor(primaryColor).fill();

        doc.fontSize(7).font('Helvetica').fillColor(darkGray);
        let billToInfoY = billToY + 15;

        doc.font('Helvetica-Bold').text(data.customer_name, 360, billToInfoY, { width: 200 });
        billToInfoY += 10;
        doc.font('Helvetica');

        if (data.company_name) {
          doc.text(data.company_name, 360, billToInfoY, { width: 200 });
          billToInfoY += 9;
        }

        if (data.department_name) {
          doc.text(`Dept: ${data.department_name}`, 360, billToInfoY, { width: 200 });
          billToInfoY += 9;
        }

        if (data.customer_email) {
          doc.text(`Email: ${data.customer_email}`, 360, billToInfoY, { width: 200 });
          billToInfoY += 9;
        }

        if (data.customer_phone) {
          doc.text(`Phone: ${data.customer_phone}`, 360, billToInfoY, { width: 200 });
          billToInfoY += 9;
        }

        if (data.location_name) {
          doc.text(`Location: ${data.location_name}`, 360, billToInfoY, { width: 200 });
          billToInfoY += 9;
        }

        // Customer Type
        if (data.customer_type) {
          doc.text(`Customer Type: ${data.customer_type}`, 360, billToInfoY, { width: 200 });
          billToInfoY += 9;
        }

        if (data.delivery_address) {
          const addressLines = data.delivery_address.split('\n');
          addressLines.forEach((line: string) => {
            if (line.trim()) {
              doc.text(`Delivery: ${line.trim()}`, 360, billToInfoY, { width: 200 });
              billToInfoY += 9;
            }
          });
        }

        // Items Table Section
        const tableStartY = Math.max(detailsY + 25, billToInfoY + 10);

        doc.rect(40, tableStartY, 520, 18).fillColor(primaryColor).fill().fillColor('#ffffff');

        doc.fontSize(8).font('Helvetica-Bold');
        doc.text('Description', 50, tableStartY + 5);
        doc.text('Qty', 360, tableStartY + 5);
        doc.text('Unit Price', 410, tableStartY + 5);
        doc.text('Total', 500, tableStartY + 5, { align: 'right', width: 60 });

        doc.fillColor(darkGray);

        // Table Rows
        let tableY = tableStartY + 20;
        const maxTableY = 750;
        const rowHeight = 12;

        data.items.forEach((item, index) => {
          if (tableY > maxTableY && index > 0) {
            doc.addPage();
            doc.rect(40, 30, 520, 20).fillColor(primaryColor).fill().fillColor('#ffffff');
            doc.fontSize(9).font('Helvetica-Bold');
            doc.text('Description', 50, 35);
            doc.text('Qty', 360, 35);
            doc.text('Unit Price', 410, 35);
            doc.text('Total', 500, 35, { align: 'right', width: 60 });
            doc.fillColor(darkGray);
            tableY = 58;
          }

          const hasOptions = item.options && item.options.length > 0;

          if (hasOptions) {
            // Product HAS options: show each option as its own row with option qty/price/total
            item.options!.forEach((opt: any, optIdx: number) => {
              if (tableY > maxTableY) {
                doc.addPage();
                doc.rect(40, 30, 520, 20).fillColor(primaryColor).fill().fillColor('#ffffff');
                doc.fontSize(9).font('Helvetica-Bold');
                doc.text('Description', 50, 35);
                doc.text('Qty', 360, 35);
                doc.text('Unit Price', 410, 35);
                doc.text('Total', 500, 35, { align: 'right', width: 60 });
                doc.fillColor(darkGray);
                tableY = 58;
              }

              if ((index + optIdx) % 2 === 0) {
                doc.rect(40, tableY - 3, 520, rowHeight).fillColor(bgGray).fill().fillColor(darkGray);
              }
              doc.moveTo(40, tableY - 3).lineTo(560, tableY - 3).strokeColor(borderGray).lineWidth(0.5).stroke();

              doc.fontSize(7).font('Helvetica');

              // Show product name only on first option row
              let displayName = '';
              if (optIdx === 0) {
                displayName = item.product_name;
                if (item.is_taxable) displayName += ' (GST)';
              }
              const optText = `${opt.option_name}: ${opt.option_value}`;
              const fullText = displayName ? `${displayName}\n  ${optText}` : `  ${optText}`;
              doc.text(displayName || '', 50, tableY + 1, { width: 300 });

              let extraHeight = 0;
              // Show comment only on first option
              if (optIdx === 0 && item.comment) {
                doc.fontSize(6).fillColor(lightGray);
                doc.text(`Note: ${item.comment}`, 55, tableY + 8, { width: 295 });
                doc.fillColor(darkGray);
                doc.fontSize(7);
                extraHeight += 7;
              }

              // Option description
              doc.fontSize(7).font('Helvetica').fillColor('#1a202c');
              doc.text(optText, 55, tableY + 9 + extraHeight, { width: 295 });
              doc.fillColor(darkGray);
              extraHeight += 10;

              // Option qty, price, total
              const optQty = parseInt(opt.option_quantity) || 1;
              const optPrice = parseFloat(opt.option_price) || 0;
              const optTotal = optPrice * optQty;
              doc.text(`x${optQty}`, 360, tableY + 1);
              doc.text(`$${optPrice.toFixed(2)}`, 410, tableY + 1);
              doc.font('Helvetica-Bold');
              doc.text(`$${optTotal.toFixed(2)}`, 500, tableY + 1, { align: 'right', width: 60 });
              doc.font('Helvetica');

              tableY += rowHeight + extraHeight;
            });
          } else {
            // Product has NO options: show product qty/price/total
            if (index % 2 === 0) {
              doc.rect(40, tableY - 3, 520, rowHeight).fillColor(bgGray).fill().fillColor(darkGray);
            }

            doc.moveTo(40, tableY - 3).lineTo(560, tableY - 3).strokeColor(borderGray).lineWidth(0.5).stroke();

            doc.fontSize(7).font('Helvetica');
            let displayName = item.product_name;
            if (item.is_taxable) {
              displayName += ' (GST)';
            }
            doc.text(displayName, 50, tableY + 1, { width: 300 });

            let extraHeight = 0;

            // Show product comment if available
            if (item.comment) {
              doc.fontSize(6).fillColor(lightGray);
              doc.text(`Note: ${item.comment}`, 55, tableY + 8, { width: 295 });
              doc.fillColor(darkGray);
              doc.fontSize(7);
              extraHeight += 7;
            }

            // Product-level qty, unit price, total
            doc.text(`x${item.quantity}`, 360, tableY + 1);
            doc.text(`$${item.price.toFixed(2)}`, 410, tableY + 1);
            doc.font('Helvetica-Bold');
            doc.text(`$${item.total.toFixed(2)}`, 500, tableY + 1, { align: 'right', width: 60 });
            doc.font('Helvetica');

            tableY += rowHeight + extraHeight;
          }
        });

        // Bottom border of table
        doc.moveTo(40, tableY - 4).lineTo(560, tableY - 4).strokeColor(borderGray).lineWidth(1).stroke();

        // Totals Section
        const totalsStartY = tableY + 3;
        const totalsWidth = 220;
        const totalsX = 340;

        doc.fontSize(7).font('Helvetica');

        let currentY: number;

        doc.text('Subtotal:', totalsX, totalsStartY, { width: 120, align: 'right' });
        doc.text(`$${data.subtotal.toFixed(2)}`, totalsX + 130, totalsStartY, { width: 90, align: 'right' });
        currentY = totalsStartY + 9;

        if (data.wholesale_discount && data.wholesale_discount > 0) {
          doc.fillColor('#dc3545');
          doc.text('Wholesale Discount:', totalsX, currentY, { width: 120, align: 'right' });
          doc.text(`-$${data.wholesale_discount.toFixed(2)}`, totalsX + 130, currentY, { width: 90, align: 'right' });
          doc.fillColor(darkGray);
          currentY += 9;
        }

        if (data.discount > 0) {
          doc.fillColor('#dc3545');
          doc.text('Coupon Discount:', totalsX, currentY, { width: 120, align: 'right' });
          doc.text(`-$${data.discount.toFixed(2)}`, totalsX + 130, currentY, { width: 90, align: 'right' });
          doc.fillColor(darkGray);
          currentY += 9;
        }

        if (data.delivery_fee > 0) {
          doc.text('Delivery Fee:', totalsX, currentY, { width: 120, align: 'right' });
          doc.text(`$${data.delivery_fee.toFixed(2)}`, totalsX + 130, currentY, { width: 90, align: 'right' });
          currentY += 9;
        }

        // Display GST - label depends on customer type
        if (data.gst > 0) {
          const gstLabel = (data.customer_type?.includes('Wholesale') || data.customer_type?.includes('Wholesaler'))
            ? 'GST (10%):'
            : 'GST (Included):';
          doc.text(gstLabel, totalsX, currentY, { width: 120, align: 'right' });
          doc.text(`$${data.gst.toFixed(2)}`, totalsX + 130, currentY, { width: 90, align: 'right' });
          currentY += 9;
        }
        currentY += 1;

        doc.moveTo(totalsX, currentY).lineTo(totalsX + totalsWidth, currentY).strokeColor(primaryColor).lineWidth(1.5).stroke();

        currentY += 4;

        doc.fontSize(10).font('Helvetica-Bold').fillColor(primaryColor);
        doc.text('Total Amount:', totalsX, currentY, { width: 120, align: 'right' });
        doc.text(`$${data.total.toFixed(2)}`, totalsX + 130, currentY, { width: 90, align: 'right' });
        doc.font('Helvetica').fontSize(7).fillColor(darkGray);
        currentY += 10;

        // Payment Information
        if (data.amount_paid > 0) {
          doc.text('Amount Paid:', totalsX, currentY, { width: 120, align: 'right' });
          doc.text(`$${data.amount_paid.toFixed(2)}`, totalsX + 130, currentY, { width: 90, align: 'right' });
          currentY += 9;

          if (data.payment_date) {
            const paidDate = new Date(data.payment_date);
            const paidDateStr = paidDate.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
            doc.text('Paid Date:', totalsX, currentY, { width: 120, align: 'right' });
            doc.text(paidDateStr, totalsX + 130, currentY, { width: 90, align: 'right' });
            currentY += 9;
          }
        }

        // Balance
        doc.moveTo(totalsX, currentY).lineTo(totalsX + totalsWidth, currentY).strokeColor(borderGray).lineWidth(0.5).stroke();
        currentY += 4;

        doc.fontSize(9).font('Helvetica-Bold');
        if (data.balance === 0) {
          doc.fillColor('#28a745'); // Green for paid
          doc.text('Balance:', totalsX, currentY, { width: 120, align: 'right' });
          doc.text(`$${data.balance.toFixed(2)}`, totalsX + 130, currentY, { width: 90, align: 'right' });
          doc.text('PAID', totalsX + 130, currentY + 10, { width: 90, align: 'right' });
        } else {
          doc.fillColor('#dc3545'); // Red for outstanding
          doc.text('Balance Due:', totalsX, currentY, { width: 120, align: 'right' });
          doc.text(`$${data.balance.toFixed(2)}`, totalsX + 130, currentY, { width: 90, align: 'right' });
        }
        doc.font('Helvetica').fontSize(7).fillColor(darkGray);
        currentY += 15;

        // Order Comments Section
        if (data.order_comments && currentY < pageHeight - 40) {
          const commentsY = currentY + 12;
          doc.fontSize(7).font('Helvetica-Bold');
          doc.text('Notes:', 40, commentsY);
          doc.font('Helvetica').fontSize(6);
          const commentLines = doc.heightOfString(data.order_comments, { width: 520 });
          if (commentsY + commentLines < pageHeight - 30) {
            doc.text(data.order_comments, 40, commentsY + 8, {
              width: 520,
              align: 'left',
            });
          }
        }

        // Footer Section
        const footerY = Math.min(pageHeight - 80, currentY + 20);

        doc.moveTo(40, footerY).lineTo(560, footerY).strokeColor(borderGray).lineWidth(0.5).stroke();

        if (footerY < pageHeight - 75) {
          let footerTextY = footerY + 5;

          // Bank Details from Location
          if (data.location_account_name || data.location_account_number || data.location_bsb) {
            doc.fontSize(7).font('Helvetica-Bold').fillColor(primaryColor);
            doc.text('Bank Details:', 40, footerTextY, { width: 520, align: 'left' });
            footerTextY += 9;

            doc.font('Helvetica').fontSize(7).fillColor(darkGray);
            if (data.location_account_name) {
              doc.text(`Account Name: ${data.location_account_name}`, 40, footerTextY, { width: 520 });
              footerTextY += 8;
            }
            if (data.location_account_number) {
              doc.text(`Account Number: ${data.location_account_number}`, 40, footerTextY, { width: 520 });
              footerTextY += 8;
            }
            if (data.location_bsb) {
              doc.text(`BSB: ${data.location_bsb}`, 40, footerTextY, { width: 520 });
              footerTextY += 8;
            }
            footerTextY += 3;
          }

          // Location Information
          if (data.location_name || data.location_address) {
            doc.fontSize(6).font('Helvetica-Bold').fillColor(darkGray);
            doc.text('Location:', 40, footerTextY, { width: 520, align: 'left' });
            footerTextY += 7;

            doc.font('Helvetica').fontSize(6).fillColor(lightGray);
            const locationInfo: string[] = [];

            if (data.location_name) {
              locationInfo.push(data.location_name);
            }
            if (data.location_address) {
              locationInfo.push(data.location_address);
            }

            if (locationInfo.length > 0) {
              doc.text(locationInfo.join(' | '), 40, footerTextY, {
                width: 520,
                align: 'left',
              });
              footerTextY += 8;
            }
          }

          // Thank you message
          const thankYouEmail = data.location_email || companySettings.companyEmail;
          const thankYouPhone = data.location_phone || companySettings.companyPhone;
          doc.fontSize(6).font('Helvetica').fillColor(lightGray);
          doc.text(`Thank you for your business! For inquiries: ${thankYouEmail} or ${thankYouPhone}`, 40, footerTextY, {
            width: 520,
            align: 'center',
          });
        }

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Get invoice URL for an order (generate if doesn't exist)
   */
  async getInvoiceUrl(orderId: number): Promise<string> {
    try {
      // Force regeneration to ensure latest design changes/logo are included
      return await this.generateInvoice(orderId);
    } catch (error) {
      this.logger.error('Get invoice URL error:', error);
      throw error;
    }
  }

  /**
   * Get invoice PDF buffer for an order (generate if doesn't exist)
   */
  async getInvoicePDF(orderId: number): Promise<Buffer> {
    try {
      const orderData = await this.fetchOrderData(orderId);
      const pdfBuffer = await this.generatePDF(orderData);
      return pdfBuffer;
    } catch (error) {
      this.logger.error('Get invoice PDF error:', error);
      throw error;
    }
  }
}

