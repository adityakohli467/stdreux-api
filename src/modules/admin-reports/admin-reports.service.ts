import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Parser } from '@json2csv/plainjs';

@Injectable()
export class AdminReportsService {
  private readonly logger = new Logger(AdminReportsService.name);

  constructor(private dataSource: DataSource) {}

  /**
   * Helper function to get status name
   */
  private getStatusName(status: number): string {
    const statusMap: { [key: number]: string } = {
      0: 'Cancelled',
      1: 'New',
      2: 'Paid',
      3: 'Completed',
      4: 'Awaiting Approval',
      5: 'Processing',
      6: 'Production',
      7: 'Approved',
      8: 'Rejected'
    };
    return statusMap[status] || 'Unknown';
  }

  /**
   * List reports with filters
   */
  async listReports(filters: {
    order_date_from?: string;
    order_date_to?: string;
    delivery_date_from?: string;
    delivery_date_to?: string;
    location_id?: number;
    company?: string;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    const {
      order_date_from,
      order_date_to,
      delivery_date_from,
      delivery_date_to,
      location_id,
      company,
      status,
      search,
      limit = 100,
      offset = 0
    } = filters;

    let query = `
      SELECT 
        o.order_id,
        COALESCE(o.date_added, o.date_modified, o.delivery_date_time) AS order_date,
        o.delivery_date_time,
        o.order_status,
        o.order_total,
        o.delivery_fee,
        COALESCE(cp.coupon_discount, 0) as coupon_discount,
        cp.type as coupon_type,
        COALESCE(
          NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''),
          NULLIF(TRIM(o.customer_order_name), ''),
          NULLIF(TRIM(CONCAT_WS(' ', o.firstname, o.lastname)), ''),
          NULLIF(TRIM(o.email), '')
        ) AS customer_name,
        c.customer_id,
        comp.company_name,
        d.department_name,
        l.location_name,
        o.customer_company_name,
        o.customer_department_name
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      LEFT JOIN company comp ON c.company_id = comp.company_id
      LEFT JOIN department d ON c.department_id = d.department_id
      LEFT JOIN locations l ON o.location_id = l.location_id
      LEFT JOIN coupon cp ON o.coupon_id = cp.coupon_id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    // Date filters (filter on the coalesced order date, cast column to ::date so the
    // "to" bound is inclusive of the whole selected day)
    if (order_date_from) {
      query += ` AND COALESCE(o.date_added, o.date_modified, o.delivery_date_time)::date >= $${paramIndex}::date`;
      params.push(order_date_from);
      paramIndex++;
    }

    if (order_date_to) {
      query += ` AND COALESCE(o.date_added, o.date_modified, o.delivery_date_time)::date <= $${paramIndex}::date`;
      params.push(order_date_to);
      paramIndex++;
    }

    if (delivery_date_from) {
      query += ` AND o.delivery_date_time::date >= $${paramIndex}::date`;
      params.push(delivery_date_from);
      paramIndex++;
    }

    if (delivery_date_to) {
      query += ` AND o.delivery_date_time::date <= $${paramIndex}::date`;
      params.push(delivery_date_to);
      paramIndex++;
    }

    // Location filter
    if (location_id) {
      query += ` AND o.location_id = $${paramIndex}`;
      params.push(Number(location_id));
      paramIndex++;
    }

    // Company filter (frontend sends the company name string, not an id)
    if (company) {
      query += ` AND (comp.company_name ILIKE $${paramIndex} OR o.customer_company_name ILIKE $${paramIndex})`;
      params.push(company);
      paramIndex++;
    }

    // Status filter - handle special statuses
    if (status) {
      if (status === '90') {
        // All minus paid
        query += ` AND o.order_status != 2`;
      } else if (status === '91') {
        // All minus cancelled
        query += ` AND o.order_status != 0`;
      } else {
        query += ` AND o.order_status = $${paramIndex}`;
        params.push(Number(status));
        paramIndex++;
      }
    }

    // Search filter
    if (search) {
      query += ` AND (
        o.order_id::text ILIKE $${paramIndex} OR
        c.firstname ILIKE $${paramIndex} OR
        c.lastname ILIKE $${paramIndex} OR
        comp.company_name ILIKE $${paramIndex} OR
        d.department_name ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ' ORDER BY COALESCE(o.date_added, o.date_modified, o.delivery_date_time) DESC';
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await this.dataSource.query(query, params);
    
    // Get total count
    let countQuery = `
      SELECT COUNT(*) 
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      LEFT JOIN company comp ON c.company_id = comp.company_id
      LEFT JOIN department d ON c.department_id = d.department_id
      WHERE 1=1
    `;
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (order_date_from) {
      countQuery += ` AND COALESCE(o.date_added, o.date_modified, o.delivery_date_time)::date >= $${countParamIndex}::date`;
      countParams.push(order_date_from);
      countParamIndex++;
    }

    if (order_date_to) {
      countQuery += ` AND COALESCE(o.date_added, o.date_modified, o.delivery_date_time)::date <= $${countParamIndex}::date`;
      countParams.push(order_date_to);
      countParamIndex++;
    }

    if (delivery_date_from) {
      countQuery += ` AND o.delivery_date_time::date >= $${countParamIndex}::date`;
      countParams.push(delivery_date_from);
      countParamIndex++;
    }

    if (delivery_date_to) {
      countQuery += ` AND o.delivery_date_time::date <= $${countParamIndex}::date`;
      countParams.push(delivery_date_to);
      countParamIndex++;
    }

    if (location_id) {
      countQuery += ` AND o.location_id = $${countParamIndex}`;
      countParams.push(Number(location_id));
      countParamIndex++;
    }

    if (company) {
      countQuery += ` AND (comp.company_name ILIKE $${countParamIndex} OR o.customer_company_name ILIKE $${countParamIndex})`;
      countParams.push(company);
      countParamIndex++;
    }

    if (status) {
      if (status === '90') {
        countQuery += ` AND o.order_status != 2`;
      } else if (status === '91') {
        countQuery += ` AND o.order_status != 0`;
      } else {
        countQuery += ` AND o.order_status = $${countParamIndex}`;
        countParams.push(Number(status));
        countParamIndex++;
      }
    }

    if (search) {
      countQuery += ` AND (
        o.order_id::text ILIKE $${countParamIndex} OR
        c.firstname ILIKE $${countParamIndex} OR
        c.lastname ILIKE $${countParamIndex} OR
        comp.company_name ILIKE $${countParamIndex} OR
        d.department_name ILIKE $${countParamIndex}
      )`;
      countParams.push(`%${search}%`);
    }

    const countResult = await this.dataSource.query(countQuery, countParams);
    const count = parseInt(countResult[0].count);

    // Fetch order products for each order to calculate subtotal correctly
    const orderIds = result.map((row: any) => row.order_id);
    let orderProductsMap: { [key: number]: any[] } = {};
    let orderOptionsMap: { [key: number]: any[] } = {};

    if (orderIds.length > 0) {
      // Get order products
      const productsQuery = `
        SELECT 
          op.order_id,
          op.total as product_total
        FROM order_product op
        WHERE op.order_id = ANY($1::int[])
      `;
      const productsResult = await this.dataSource.query(productsQuery, [orderIds]);
      productsResult.forEach((row: any) => {
        if (!orderProductsMap[row.order_id]) {
          orderProductsMap[row.order_id] = [];
        }
        orderProductsMap[row.order_id].push(row);
      });

      // Get order product options
      const optionsQuery = `
        SELECT 
          opo.order_id,
          opo.option_price,
          opo.option_quantity
        FROM order_product_option opo
        WHERE opo.order_id = ANY($1::int[])
      `;
      const optionsResult = await this.dataSource.query(optionsQuery, [orderIds]);
      optionsResult.forEach((row: any) => {
        if (!orderOptionsMap[row.order_id]) {
          orderOptionsMap[row.order_id] = [];
        }
        orderOptionsMap[row.order_id].push(row);
      });
    }

    // Calculate totals for summary
    const reports = result.map((row: any) => {
      // Calculate subtotal from products
      let subtotal = 0;
      if (orderProductsMap[row.order_id]) {
        orderProductsMap[row.order_id].forEach((product: any) => {
          subtotal += parseFloat(product.product_total || 0);
        });
      }
      
      // Add options to subtotal
      if (orderOptionsMap[row.order_id]) {
        orderOptionsMap[row.order_id].forEach((option: any) => {
          subtotal += parseFloat(option.option_price || 0) * parseFloat(option.option_quantity || 0);
        });
      }

      const deliveryFee = parseFloat(row.delivery_fee) || 0;
      const couponDiscount = parseFloat(row.coupon_discount) || 0;
      const couponType = row.coupon_type;
      
      // Calculate discount based on coupon type
      let discount = 0;
      if (couponType && couponDiscount > 0) {
        if (couponType === 'P') {
          // Percentage discount
          discount = subtotal * (couponDiscount / 100);
        } else if (couponType === 'F') {
          // Fixed discount
          discount = couponDiscount;
        }
        // Ensure discount doesn't exceed subtotal
        discount = Math.min(discount, subtotal);
      }
      
      // Calculate GST on amount after discount
      const afterDiscount = subtotal - discount;
      const gst = afterDiscount / 10; // GST = amount/10
      
      // Total = subtotal - discount + GST + delivery fee
      const total = afterDiscount + gst + deliveryFee;

      return {
        ...row,
        subtotal,
        delivery_fee: deliveryFee,
        discount,
        gst,
        total,
        customer_name: row.customer_name || 'N/A',
        company_name: row.company_name || row.customer_company_name || 'N/A',
        department_name: row.department_name || row.customer_department_name || 'N/A',
        location_name: row.location_name || 'N/A'
      };
    });

    return {
      reports,
      count,
      limit: Number(limit),
      offset: Number(offset)
    };
  }

  /**
   * Download CSV report
   */
  async downloadCSV(filters: {
    order_date_from?: string;
    order_date_to?: string;
    delivery_date_from?: string;
    delivery_date_to?: string;
    location_id?: number;
    company?: string;
    status?: string;
    search?: string;
  }) {
    const {
      order_date_from,
      order_date_to,
      delivery_date_from,
      delivery_date_to,
      location_id,
      company,
      status,
      search
    } = filters;

    let query = `
      SELECT 
        o.order_id,
        COALESCE(o.date_added, o.date_modified, o.delivery_date_time) AS order_date,
        o.delivery_date_time,
        o.order_status,
        o.order_total,
        o.delivery_fee,
        COALESCE(cp.coupon_discount, 0) as coupon_discount,
        cp.type as coupon_type,
        COALESCE(
          NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''),
          NULLIF(TRIM(o.customer_order_name), ''),
          NULLIF(TRIM(CONCAT_WS(' ', o.firstname, o.lastname)), ''),
          NULLIF(TRIM(o.email), '')
        ) AS customer_name,
        comp.company_name,
        d.department_name,
        l.location_name,
        o.customer_company_name,
        o.customer_department_name
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      LEFT JOIN company comp ON c.company_id = comp.company_id
      LEFT JOIN department d ON c.department_id = d.department_id
      LEFT JOIN locations l ON o.location_id = l.location_id
      LEFT JOIN coupon cp ON o.coupon_id = cp.coupon_id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    // Apply same filters as listReports
    if (order_date_from) {
      query += ` AND COALESCE(o.date_added, o.date_modified, o.delivery_date_time)::date >= $${paramIndex}::date`;
      params.push(order_date_from);
      paramIndex++;
    }

    if (order_date_to) {
      query += ` AND COALESCE(o.date_added, o.date_modified, o.delivery_date_time)::date <= $${paramIndex}::date`;
      params.push(order_date_to);
      paramIndex++;
    }

    if (delivery_date_from) {
      query += ` AND o.delivery_date_time::date >= $${paramIndex}::date`;
      params.push(delivery_date_from);
      paramIndex++;
    }

    if (delivery_date_to) {
      query += ` AND o.delivery_date_time::date <= $${paramIndex}::date`;
      params.push(delivery_date_to);
      paramIndex++;
    }

    if (location_id) {
      query += ` AND o.location_id = $${paramIndex}`;
      params.push(Number(location_id));
      paramIndex++;
    }

    // Company filter (frontend sends the company name string, not an id)
    if (company) {
      query += ` AND (comp.company_name ILIKE $${paramIndex} OR o.customer_company_name ILIKE $${paramIndex})`;
      params.push(company);
      paramIndex++;
    }

    if (status) {
      if (status === '90') {
        query += ` AND o.order_status != 2`;
      } else if (status === '91') {
        query += ` AND o.order_status != 0`;
      } else {
        query += ` AND o.order_status = $${paramIndex}`;
        params.push(Number(status));
        paramIndex++;
      }
    }

    if (search) {
      query += ` AND (
        o.order_id::text ILIKE $${paramIndex} OR
        c.firstname ILIKE $${paramIndex} OR
        c.lastname ILIKE $${paramIndex} OR
        comp.company_name ILIKE $${paramIndex} OR
        d.department_name ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ' ORDER BY COALESCE(o.date_added, o.date_modified, o.delivery_date_time) DESC';

    const result = await this.dataSource.query(query, params);
    
    // Fetch order products and options for accurate calculations
    const orderIds = result.map((row: any) => row.order_id);
    let orderProductsMap: { [key: number]: any[] } = {};
    let orderOptionsMap: { [key: number]: any[] } = {};

    if (orderIds.length > 0) {
      const productsQuery = `
        SELECT 
          op.order_id,
          op.total as product_total
        FROM order_product op
        WHERE op.order_id = ANY($1::int[])
      `;
      const productsResult = await this.dataSource.query(productsQuery, [orderIds]);
      productsResult.forEach((row: any) => {
        if (!orderProductsMap[row.order_id]) {
          orderProductsMap[row.order_id] = [];
        }
        orderProductsMap[row.order_id].push(row);
      });

      const optionsQuery = `
        SELECT 
          opo.order_id,
          opo.option_price,
          opo.option_quantity
        FROM order_product_option opo
        WHERE opo.order_id = ANY($1::int[])
      `;
      const optionsResult = await this.dataSource.query(optionsQuery, [orderIds]);
      optionsResult.forEach((row: any) => {
        if (!orderOptionsMap[row.order_id]) {
          orderOptionsMap[row.order_id] = [];
        }
        orderOptionsMap[row.order_id].push(row);
      });
    }
    
    const csvData = result.map((row: any) => {
      // Calculate subtotal from products
      let subtotal = 0;
      if (orderProductsMap[row.order_id]) {
        orderProductsMap[row.order_id].forEach((product: any) => {
          subtotal += parseFloat(product.product_total || 0);
        });
      }
      
      // Add options to subtotal
      if (orderOptionsMap[row.order_id]) {
        orderOptionsMap[row.order_id].forEach((option: any) => {
          subtotal += parseFloat(option.option_price || 0) * parseFloat(option.option_quantity || 0);
        });
      }

      const deliveryFee = parseFloat(row.delivery_fee) || 0;
      const couponDiscount = parseFloat(row.coupon_discount) || 0;
      const couponType = row.coupon_type;
      
      // Calculate discount based on coupon type
      let discount = 0;
      if (couponType && couponDiscount > 0) {
        if (couponType === 'P') {
          discount = subtotal * (couponDiscount / 100);
        } else if (couponType === 'F') {
          discount = couponDiscount;
        }
        discount = Math.min(discount, subtotal);
      }
      const afterDiscount = subtotal - discount;
      const gst = afterDiscount / 10; // GST = amount/10
      const total = afterDiscount + gst + deliveryFee;

      return {
        'Order ID': row.order_id,
        'Order Date': row.order_date,
        'Delivery Date': row.delivery_date_time,
        'Customer': row.customer_name || 'N/A',
        'Company': row.company_name || row.customer_company_name || 'N/A',
        'Department': row.department_name || row.customer_department_name || 'N/A',
        'Location': row.location_name || 'N/A',
        'Status': this.getStatusName(row.order_status),
        'Subtotal': subtotal.toFixed(2),
        'Delivery Fee': deliveryFee.toFixed(2),
        'Discount': discount.toFixed(2),
        'GST': gst.toFixed(2),
        'Total': total.toFixed(2)
      };
    });

    const fields = [
      'Order ID',
      'Order Date',
      'Delivery Date',
      'Customer',
      'Company',
      'Department',
      'Location',
      'Status',
      'Subtotal',
      'Delivery Fee',
      'Discount',
      'GST',
      'Total'
    ];

    const parser = new Parser({ fields });
    const csv = csvData.length > 0 ? parser.parse(csvData) : parser.parse([]);

    return csv;
  }
}
