import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class AdminCouponsService implements OnModuleInit {
  private readonly logger = new Logger(AdminCouponsService.name);

  constructor(private dataSource: DataSource) {}

  async onModuleInit() {
    try {
      await this.dataSource.query(
        `ALTER TABLE coupon ADD COLUMN IF NOT EXISTS customer_types varchar(100)`,
      );
    } catch (error) {
      this.logger.error('Failed to ensure coupon.customer_types column', error);
    }
  }

  /**
   * Normalize the incoming customer_types value (array or comma string) into a
   * comma-separated lowercase string limited to the allowed types. Returns null
   * when no valid type is selected, which means the coupon applies to everyone.
   */
  private normalizeCustomerTypes(input: any): string | null {
    if (input === undefined || input === null) return null;
    let arr: any[] = [];
    if (Array.isArray(input)) {
      arr = input;
    } else if (typeof input === 'string') {
      arr = input.split(',');
    } else {
      return null;
    }
    const allowed = ['retail', 'vip', 'wholesale'];
    const cleaned = arr
      .map((s) => String(s).trim().toLowerCase())
      .filter((s) => allowed.includes(s));
    const unique = Array.from(new Set(cleaned));
    return unique.length > 0 ? unique.join(',') : null;
  }

  async findAll(query: any): Promise<any> {
    const { status } = query;

    let sqlQuery = 'SELECT * FROM coupon';
    const params: any[] = [];

    if (status !== undefined) {
      sqlQuery += ' WHERE status = $1';
      params.push(Number(status));
    }

    sqlQuery += ' ORDER BY coupon_id DESC';

    const result = await this.dataSource.query(sqlQuery, params);
    return { coupons: result };
  }

  async findOne(id: number): Promise<any> {
    const result = await this.dataSource.query('SELECT * FROM coupon WHERE coupon_id = $1', [id]);

    if (result.length === 0) {
      throw new NotFoundException('Coupon not found');
    }

    return { coupon: result[0] };
  }

  async validateCoupon(code: string): Promise<any> {
    if (!code) {
      throw new BadRequestException('Coupon code is required');
    }

    const result = await this.dataSource.query('SELECT * FROM coupon WHERE coupon_code = $1 AND status = 1', [code]);

    if (result.length === 0) {
      return { valid: false, message: 'Invalid or inactive coupon code' };
    }

    return { valid: true, coupon: result[0] };
  }

  async create(createCouponDto: any): Promise<any> {
    if (!createCouponDto || typeof createCouponDto !== 'object') {
      throw new BadRequestException('Invalid request body');
    }

    const { coupon_code, coupon_description, coupon_discount, type, status, show_on_storefront, customer_types } = createCouponDto;

    if (!coupon_code || (typeof coupon_code === 'string' && !coupon_code.trim())) {
      throw new BadRequestException('Coupon code is required');
    }

    try {
      const result = await this.dataSource.query(
        `INSERT INTO coupon (coupon_code, coupon_description, coupon_discount, type, status, show_on_storefront, customer_types)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [coupon_code, coupon_description, coupon_discount, type || 'F', status !== undefined ? status : 1, show_on_storefront || false, this.normalizeCustomerTypes(customer_types)],
      );

      return { coupon: result[0], message: 'Coupon created successfully' };
    } catch (error: any) {
      if (error.code === '23502' || error.message?.includes('violates not-null constraint')) {
        throw new BadRequestException('Coupon code is required');
      }
      throw error;
    }
  }

  async update(id: number, updateCouponDto: any): Promise<any> {
    const { coupon_code, coupon_description, coupon_discount, type, status, show_on_storefront, customer_types } = updateCouponDto;

    const result = await this.dataSource.query(
      `UPDATE coupon SET
        coupon_code = $1,
        coupon_description = $2,
        coupon_discount = $3,
        type = $4,
        status = $5,
        show_on_storefront = $6,
        customer_types = $7
      WHERE coupon_id = $8
      RETURNING *`,
      [coupon_code, coupon_description, coupon_discount, type, status, show_on_storefront, this.normalizeCustomerTypes(customer_types), id],
    );

    if (result.length === 0) {
      throw new NotFoundException('Coupon not found');
    }

    return { coupon: result[0], message: 'Coupon updated successfully' };
  }

  async delete(id: number): Promise<void> {
    await this.dataSource.query('DELETE FROM coupon WHERE coupon_id = $1', [id]);
  }
}
