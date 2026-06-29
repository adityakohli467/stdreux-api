import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class StoreCouponsService {
  private readonly logger = new Logger(StoreCouponsService.name);
  private columnsChecked = false;
  private hasDateColumns = false;
  private hasShowOnStorefront = false;
  private hasCustomerTypes = false;

  constructor(
    private dataSource: DataSource,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Extract user ID from a JWT token (no signature verification needed here).
   */
  private extractUserIdFromToken(authHeader?: string): number | null {
    try {
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const decoded = this.jwtService.decode(token) as any;
        return decoded?.user_id || decoded?.id || null;
      }
    } catch (error) {
      // Token invalid or not provided
    }
    return null;
  }

  /**
   * Determine which coupon customer types the logged-in customer belongs to.
   * A customer is always either 'retail' or 'wholesale' (based on customer_type)
   * and may additionally be 'vip'. Guests return an empty list.
   */
  private async getCustomerEligibilityTypes(
    userId: number | null,
  ): Promise<string[]> {
    if (!userId) return [];
    try {
      const colCheck = await this.dataSource.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'customer' AND column_name IN ('vip', 'customer_type')
      `);
      const hasVip = colCheck.some((c: any) => c.column_name === 'vip');
      const result = await this.dataSource.query(
        `SELECT ${hasVip ? 'COALESCE(vip, false) AS vip' : 'false AS vip'}, customer_type FROM customer WHERE user_id = $1`,
        [userId],
      );
      if (result.length === 0) return [];
      const row = result[0];
      const ct = (row.customer_type || '').toString().toLowerCase();
      const types: string[] = [];
      if (row.vip === true) types.push('vip');
      const isWholesale =
        ct.includes('wholesale') ||
        ct.includes('wholesaler') ||
        ct.startsWith('full service') ||
        ct.startsWith('partial service');
      types.push(isWholesale ? 'wholesale' : 'retail');
      return types;
    } catch (error) {
      this.logger.error('Error resolving customer eligibility types:', error);
      return [];
    }
  }

  /**
   * Check whether a customer is eligible for a coupon based on its restricted
   * customer types. A coupon with no restriction (null/empty) is open to all.
   */
  private isEligibleForCustomerTypes(
    couponCustomerTypes: string | null | undefined,
    customerTypes: string[],
  ): boolean {
    if (!couponCustomerTypes) return true;
    const allowed = couponCustomerTypes
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length === 0) return true;
    return customerTypes.some((t) => allowed.includes(t));
  }

  /**
   * Check if date_start and date_end columns exist in coupon table
   */
  private async checkDateColumnsExist(): Promise<boolean> {
    if (this.columnsChecked) {
      return this.hasDateColumns;
    }

    try {
      const result = await this.dataSource.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'coupon'
          AND table_schema = 'public'
          AND column_name IN ('date_start', 'date_end', 'show_on_storefront', 'customer_types')
      `);
      const columns = result.map((c: any) => c.column_name.toLowerCase());
      this.hasDateColumns = columns.includes('date_start') && columns.includes('date_end');
      this.hasShowOnStorefront = columns.includes('show_on_storefront');
      this.hasCustomerTypes = columns.includes('customer_types');
      this.columnsChecked = true;
      return this.hasDateColumns;
    } catch (error) {
      this.logger.error('Error checking coupon columns:', error);
      this.columnsChecked = true;
      this.hasDateColumns = false;
      this.hasShowOnStorefront = false;
      this.hasCustomerTypes = false;
      return false;
    }
  }

  /**
   * Get list of available coupons for customers
   */
  async getAvailableCoupons(authHeader?: string) {
    await this.checkDateColumnsExist();

    let query = `
      SELECT
        coupon_id,
        coupon_code,
        coupon_description,
        coupon_discount,
        type
        ${this.hasDateColumns ? ', date_start, date_end' : ''}
        ${this.hasCustomerTypes ? ', customer_types' : ''}
      FROM coupon
      WHERE status = 1
    `;

    if (this.hasDateColumns) {
      query += `
        AND (date_start IS NULL OR date_start <= CURRENT_DATE)
        AND (date_end IS NULL OR date_end >= CURRENT_DATE)
      `;
    }

    if (this.hasShowOnStorefront) {
      query += ` AND show_on_storefront = true`;
    }

    query += ` ORDER BY coupon_discount DESC`;

    const result = await this.dataSource.query(query);

    // Filter out coupons the current customer is not eligible for.
    const customerTypes = await this.getCustomerEligibilityTypes(
      this.extractUserIdFromToken(authHeader),
    );
    const eligible = result.filter((coupon: any) =>
      this.isEligibleForCustomerTypes(coupon.customer_types, customerTypes),
    );

    const coupons = eligible.map((coupon: any) => ({
      code: coupon.coupon_code,
      description: coupon.coupon_description,
      type: coupon.type === 'P' ? 'percentage' : 'fixed',
      value: parseFloat(coupon.coupon_discount),
      valid_from: coupon.date_start || null,
      valid_until: coupon.date_end || null,
    }));

    return {
      coupons,
      total: coupons.length,
    };
  }

  /**
   * Validate coupon code
   */
  async validateCoupon(
    data: { coupon_code: string; order_total?: number },
    authHeader?: string,
  ) {
    const { coupon_code, order_total = 0 } = data;

    if (!coupon_code) {
      throw new BadRequestException('Coupon code is required');
    }

    const hasDateColumns = await this.checkDateColumnsExist();

    // Trim whitespace and make case-insensitive lookup
    const normalizedCouponCode = (coupon_code || '').trim().toUpperCase();

    let query: string;
    if (hasDateColumns) {
      query = `
        SELECT
          coupon_id,
          coupon_code,
          coupon_description,
          coupon_discount,
          type,
          status,
          date_start,
          date_end
          ${this.hasCustomerTypes ? ', customer_types' : ''}
        FROM coupon
        WHERE UPPER(TRIM(coupon_code)) = $1 AND status = 1
      `;
    } else {
      query = `
        SELECT
          coupon_id,
          coupon_code,
          coupon_description,
          coupon_discount,
          type,
          status
          ${this.hasCustomerTypes ? ', customer_types' : ''}
        FROM coupon
        WHERE UPPER(TRIM(coupon_code)) = $1 AND status = 1
      `;
    }

    const result = await this.dataSource.query(query, [normalizedCouponCode]);
    const coupon = result[0];

    if (!coupon) {
      throw new NotFoundException({
        message: 'Coupon not found or expired',
        valid: false,
      });
    }

    // Enforce customer-type eligibility if the coupon is restricted.
    if (this.hasCustomerTypes && coupon.customer_types) {
      const customerTypes = await this.getCustomerEligibilityTypes(
        this.extractUserIdFromToken(authHeader),
      );
      if (!this.isEligibleForCustomerTypes(coupon.customer_types, customerTypes)) {
        throw new BadRequestException({
          message: 'This coupon is not valid for your account type',
          valid: false,
        });
      }
    }

    // Check if coupon is within valid date range (only if columns exist)
    if (hasDateColumns) {
      const now = new Date();
      if (coupon.date_start && new Date(coupon.date_start) > now) {
        throw new BadRequestException({
          message: 'Coupon is not yet active',
          valid: false,
        });
      }
      if (coupon.date_end && new Date(coupon.date_end) < now) {
        throw new BadRequestException({
          message: 'Coupon has expired',
          valid: false,
        });
      }
    }

    // Calculate discount
    let discount = 0;
    if (coupon.type === 'P') {
      // Percentage discount
      discount = (order_total * parseFloat(coupon.coupon_discount)) / 100;
    } else if (coupon.type === 'F') {
      // Fixed amount discount
      discount = parseFloat(coupon.coupon_discount);
    }

    // Don't allow discount to exceed order total
    discount = Math.min(discount, order_total);

    return {
      valid: true,
      coupon: {
        code: coupon.coupon_code,
        name: coupon.coupon_description,
        type: coupon.type === 'P' ? 'percentage' : 'fixed',
        value: parseFloat(coupon.coupon_discount),
        discount_amount: parseFloat(discount.toFixed(2)),
      },
    };
  }
}
