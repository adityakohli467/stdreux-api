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
  private hasRecurrence = false;
  private hasCategories = false;
  private hasExpiryDate = false;

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
   * Parse a comma-separated list of category ids from the coupon.categories column.
   */
  private resolveAllowedCategoryIds(
    categories: string | null | undefined,
  ): number[] {
    if (!categories) return [];
    return String(categories)
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
  }

  /**
   * Normalize the recurrence value. Anything other than 'once' is treated as
   * repeatable ('multiple').
   */
  private normalizeRecurrence(recurrence: string | null | undefined): string {
    return (recurrence || '').toString().trim().toLowerCase() === 'once'
      ? 'once'
      : 'multiple';
  }

  /**
   * Compute the subtotal of the provided cart items that belong to one of the
   * allowed categories (direct product_category membership or product subcategory).
   */
  private async computeEligibleSubtotal(
    items: Array<{
      product_id: number;
      quantity?: number;
      price?: number;
      total?: number;
    }>,
    allowedCategoryIds: number[],
  ): Promise<number> {
    if (!items || items.length === 0 || allowedCategoryIds.length === 0) {
      return 0;
    }
    const productIds = Array.from(
      new Set(items.map((i) => Number(i.product_id)).filter((n) => !isNaN(n))),
    );
    if (productIds.length === 0) return 0;

    const rows = await this.dataSource.query(
      `SELECT DISTINCT pc.product_id
         FROM product_category pc
        WHERE pc.category_id = ANY($1::int[])
          AND pc.product_id = ANY($2::int[])
       UNION
       SELECT DISTINCT p.product_id
         FROM product p
        WHERE p.subcategory_id = ANY($1::int[])
          AND p.product_id = ANY($2::int[])`,
      [allowedCategoryIds, productIds],
    );
    const eligibleProductIds = new Set(
      rows.map((r: any) => Number(r.product_id)),
    );

    let subtotal = 0;
    for (const item of items) {
      const pid = Number(item.product_id);
      if (!eligibleProductIds.has(pid)) continue;
      const lineTotal =
        item.total != null
          ? Number(item.total)
          : Number(item.price || 0) * Number(item.quantity || 0);
      if (!isNaN(lineTotal)) subtotal += lineTotal;
    }
    return subtotal;
  }

  /**
   * Whether a logged-in customer has already redeemed a coupon in a prior order.
   */
  private async hasCustomerUsedCoupon(
    userId: number,
    couponId: number,
  ): Promise<boolean> {
    try {
      const rows = await this.dataSource.query(
        `SELECT 1 FROM orders WHERE coupon_id = $1 AND user_id = $2 LIMIT 1`,
        [couponId, userId],
      );
      return rows.length > 0;
    } catch (error) {
      this.logger.error('Error checking prior coupon usage:', error);
      return false;
    }
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
          AND column_name IN ('date_start', 'date_end', 'show_on_storefront', 'customer_types', 'recurrence', 'categories', 'expiry_date')
      `);
      const columns = result.map((c: any) => c.column_name.toLowerCase());
      this.hasDateColumns = columns.includes('date_start') && columns.includes('date_end');
      this.hasShowOnStorefront = columns.includes('show_on_storefront');
      this.hasCustomerTypes = columns.includes('customer_types');
      this.hasRecurrence = columns.includes('recurrence');
      this.hasCategories = columns.includes('categories');
      this.hasExpiryDate = columns.includes('expiry_date');
      this.columnsChecked = true;
      return this.hasDateColumns;
    } catch (error) {
      this.logger.error('Error checking coupon columns:', error);
      this.columnsChecked = true;
      this.hasDateColumns = false;
      this.hasShowOnStorefront = false;
      this.hasCustomerTypes = false;
      this.hasRecurrence = false;
      this.hasCategories = false;
      this.hasExpiryDate = false;
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
    data: {
      coupon_code: string;
      order_total?: number;
      items?: Array<{
        product_id: number;
        quantity?: number;
        price?: number;
        total?: number;
      }>;
    },
    authHeader?: string,
  ) {
    const { coupon_code, order_total = 0, items = [] } = data;

    if (!coupon_code) {
      throw new BadRequestException('Coupon code is required');
    }

    const hasDateColumns = await this.checkDateColumnsExist();

    // Trim whitespace and make case-insensitive lookup
    const normalizedCouponCode = (coupon_code || '').trim().toUpperCase();

    const extraCols: string[] = [];
    if (hasDateColumns) extraCols.push('date_start', 'date_end');
    if (this.hasCustomerTypes) extraCols.push('customer_types');
    if (this.hasRecurrence) extraCols.push('recurrence');
    if (this.hasCategories) extraCols.push('categories');
    if (this.hasExpiryDate) extraCols.push('expiry_date');

    const query = `
      SELECT
        coupon_id,
        coupon_code,
        coupon_description,
        coupon_discount,
        type,
        status${extraCols.length ? ',\n        ' + extraCols.join(',\n        ') : ''}
      FROM coupon
      WHERE UPPER(TRIM(coupon_code)) = $1 AND status = 1
    `;

    const result = await this.dataSource.query(query, [normalizedCouponCode]);
    const coupon = result[0];

    if (!coupon) {
      throw new NotFoundException({
        message: 'Coupon not found or expired',
        valid: false,
      });
    }

    // Determine restrictions carried by this coupon.
    const allowedCategoryIds = this.hasCategories
      ? this.resolveAllowedCategoryIds(coupon.categories)
      : [];
    const isOneTime =
      this.hasRecurrence &&
      this.normalizeRecurrence(coupon.recurrence) === 'once';
    const hasCustomerTypeRestriction =
      this.hasCustomerTypes && !!coupon.customer_types;
    const isRestricted =
      hasCustomerTypeRestriction || isOneTime || allowedCategoryIds.length > 0;

    // Restricted coupons require an authenticated customer.
    const userId = this.extractUserIdFromToken(authHeader);
    if (isRestricted && !userId) {
      throw new BadRequestException({
        message: 'Please log in to use this coupon code',
        valid: false,
      });
    }

    // Enforce customer-type eligibility if the coupon is restricted.
    if (hasCustomerTypeRestriction) {
      const customerTypes = await this.getCustomerEligibilityTypes(userId);
      if (
        !this.isEligibleForCustomerTypes(coupon.customer_types, customerTypes)
      ) {
        throw new BadRequestException({
          message: 'This coupon is not valid for your account type',
          valid: false,
        });
      }
    }

    // Enforce one-time redemption per customer.
    if (isOneTime && userId) {
      const alreadyUsed = await this.hasCustomerUsedCoupon(
        userId,
        coupon.coupon_id,
      );
      if (alreadyUsed) {
        throw new BadRequestException({
          message: 'You have already used this coupon',
          valid: false,
        });
      }
    }

    // Check expiry date (date-only comparison).
    if (this.hasExpiryDate && coupon.expiry_date) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const expiry = new Date(coupon.expiry_date);
      expiry.setHours(0, 0, 0, 0);
      if (expiry < today) {
        throw new BadRequestException({
          message: 'Coupon has expired',
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

    // Determine the subtotal the discount applies to. For category-restricted
    // coupons the discount only applies to eligible-category items.
    let applicableSubtotal = order_total;
    if (allowedCategoryIds.length > 0) {
      applicableSubtotal = await this.computeEligibleSubtotal(
        items,
        allowedCategoryIds,
      );
      if (applicableSubtotal <= 0) {
        throw new BadRequestException({
          message:
            'This coupon can only be applied to eligible category products in your cart',
          valid: false,
        });
      }
    }

    // Calculate discount
    let discount = 0;
    if (coupon.type === 'P') {
      // Percentage discount
      discount = (applicableSubtotal * parseFloat(coupon.coupon_discount)) / 100;
    } else if (coupon.type === 'F') {
      // Fixed amount discount
      discount = parseFloat(coupon.coupon_discount);
    }

    // Don't allow discount to exceed the applicable subtotal.
    discount = Math.min(discount, applicableSubtotal);

    return {
      valid: true,
      coupon: {
        code: coupon.coupon_code,
        name: coupon.coupon_description,
        type: coupon.type === 'P' ? 'percentage' : 'fixed',
        value: parseFloat(coupon.coupon_discount),
        discount_amount: parseFloat(discount.toFixed(2)),
        applicable_subtotal: parseFloat(applicableSubtotal.toFixed(2)),
        category_restricted: allowedCategoryIds.length > 0,
      },
    };
  }
}
