import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

export interface PricingResult {
  basePrice: number; // Base price based on customer type (retail or wholesale)
  finalPrice: number; // Final price after applying discounts
  originalPrice: number; // Original retail price
  wholesalePrice: number; // Wholesale price
  discountPercentage: number; // Applied discount percentage
  hasDiscount: boolean;
  isWholesale: boolean;
}

export interface OptionPricingResult {
  basePrice: number; // Base price based on customer type
  finalPrice: number; // Final price after applying discounts
  discountPercentage: number;
  hasDiscount: boolean;
}

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);

  constructor(
    @InjectDataSource() private dataSource: DataSource,
  ) {}

  /**
   * Get customer type and determine if wholesale
   */
  async getCustomerType(customerId: number): Promise<{ customerType: string | null; isWholesale: boolean }> {
    try {
      const result = await this.dataSource.query(
        `SELECT customer_type FROM customer WHERE customer_id = $1`,
        [customerId],
      );
      
      if (result.length === 0) {
        return { customerType: null, isWholesale: false };
      }

      const customerType = result[0].customer_type || null;
      const isWholesale = customerType && (
        customerType.toLowerCase().includes('wholesale') ||
        customerType.toLowerCase().includes('wholesaler') ||
        customerType.toLowerCase().startsWith('full service') ||
        customerType.toLowerCase().startsWith('partial service')
      );

      return { customerType, isWholesale };
    } catch (error) {
      this.logger.error('Error fetching customer type:', error);
      return { customerType: null, isWholesale: false };
    }
  }

  /**
   * Get customer discounts (product-level and option-level)
   */
  async getCustomerDiscounts(customerId: number): Promise<{
    productDiscounts: Map<number, number>;
    optionDiscounts: Map<string, number>;
  }> {
    const productDiscounts = new Map<number, number>();
    const optionDiscounts = new Map<string, number>();

    try {
      // Get product-level discounts
      const productDiscountQuery = `
        SELECT product_id, discount_percentage
        FROM customer_product_discount
        WHERE customer_id = $1
      `;
      const productDiscountResult = await this.dataSource.query(productDiscountQuery, [customerId]);
      productDiscountResult.forEach((row: any) => {
        if (row.discount_percentage > 0) {
          productDiscounts.set(row.product_id, parseFloat(row.discount_percentage));
        }
      });

      // Get option-level discounts
      const optionDiscountQuery = `
        SELECT product_id, option_value_id, discount_percentage
        FROM customer_product_option_discount
        WHERE customer_id = $1
      `;
      const optionDiscountResult = await this.dataSource.query(optionDiscountQuery, [customerId]);
      optionDiscountResult.forEach((row: any) => {
        if (row.discount_percentage > 0) {
          const key = `${row.product_id}_${row.option_value_id}`;
          optionDiscounts.set(key, parseFloat(row.discount_percentage));
        }
      });
    } catch (error) {
      this.logger.error('Error fetching customer discounts:', error);
    }

    return { productDiscounts, optionDiscounts };
  }

  /**
   * Resolve the company_id for a given customer (or null if none / no company table)
   */
  async getCompanyIdForCustomer(customerId: number | null): Promise<number | null> {
    if (!customerId) {
      return null;
    }
    try {
      const result = await this.dataSource.query(
        `SELECT company_id FROM customer WHERE customer_id = $1`,
        [customerId],
      );
      if (result.length > 0 && result[0].company_id) {
        return parseInt(result[0].company_id);
      }
      return null;
    } catch (error) {
      this.logger.error('Error resolving company for customer:', error);
      return null;
    }
  }

  /**
   * Get company-level discounts (product-level and option-level).
   * Company discounts apply only to wholesale customers (on their wholesale tier price)
   * and take precedence over customer discounts.
   */
  async getCompanyDiscounts(companyId: number): Promise<{
    productDiscounts: Map<number, number>;
    optionDiscounts: Map<string, number>;
  }> {
    const productDiscounts = new Map<number, number>();
    const optionDiscounts = new Map<string, number>();

    if (!companyId) {
      return { productDiscounts, optionDiscounts };
    }

    try {
      // Get product-level discounts
      const productDiscountQuery = `
        SELECT product_id, discount_percentage
        FROM company_product_discount
        WHERE company_id = $1
      `;
      const productDiscountResult = await this.dataSource.query(productDiscountQuery, [companyId]);
      productDiscountResult.forEach((row: any) => {
        if (row.discount_percentage > 0) {
          productDiscounts.set(row.product_id, parseFloat(row.discount_percentage));
        }
      });

      // Get option-level discounts
      const optionDiscountQuery = `
        SELECT product_id, option_value_id, discount_percentage
        FROM company_product_option_discount
        WHERE company_id = $1
      `;
      const optionDiscountResult = await this.dataSource.query(optionDiscountQuery, [companyId]);
      optionDiscountResult.forEach((row: any) => {
        if (row.discount_percentage > 0) {
          const key = `${row.product_id}_${row.option_value_id}`;
          optionDiscounts.set(key, parseFloat(row.discount_percentage));
        }
      });
    } catch (error) {
      // Tables may not exist yet on environments without the company-pricing migration
      this.logger.error('Error fetching company discounts:', error);
    }

    return { productDiscounts, optionDiscounts };
  }

  /**
   * Scale a raw tier price field by a discount %, preserving null/empty values and the value type.
   */
  applyDiscountToPrice(value: any, discountPercentage: number): any {
    if (!discountPercentage || discountPercentage <= 0) return value;
    if (value === null || value === undefined || value === '') return value;
    const n = parseFloat(value.toString());
    if (isNaN(n)) return value;
    const discounted = Math.round((n * (1 - discountPercentage / 100) + Number.EPSILON) * 100) / 100;
    return typeof value === 'number' ? discounted : discounted.toFixed(2);
  }

  /**
   * Calculate product price based on customer type and discounts.
   * companyDiscount applies only to wholesale customers and takes precedence over productDiscount.
   */
  calculateProductPrice(
    retailPrice: number,
    wholesalePrice: number | null,
    retailDiscountPercentage: number | null,
    isWholesale: boolean,
    productDiscount: number = 0,
    userPrice: number | null = null,
    companyDiscount: number = 0,
  ): PricingResult {
    const originalRetailPrice = parseFloat(retailPrice.toString()) || 0;
    
    // Calculate wholesale price if not provided
    let calculatedWholesalePrice: number;
    if (wholesalePrice !== null && wholesalePrice !== undefined) {
      calculatedWholesalePrice = parseFloat(wholesalePrice.toString());
    } else {
      const discount = parseFloat((retailDiscountPercentage || 0).toString());
      calculatedWholesalePrice = discount > 0 ? originalRetailPrice * (1 - discount / 100) : originalRetailPrice;
    }

    // Determine base price based on customer type or user_price override
    let basePrice: number;
    
    if (userPrice !== null && userPrice !== undefined && parseFloat(userPrice.toString()) > 0) {
      basePrice = parseFloat(userPrice.toString());
    } else {
      basePrice = isWholesale ? calculatedWholesalePrice : originalRetailPrice;
    }

    let finalPrice = basePrice;
    let discountPercentage = 0;
    const effectiveDiscount = isWholesale && companyDiscount > 0 ? companyDiscount : productDiscount;
    if (effectiveDiscount > 0) {
      discountPercentage = effectiveDiscount;
      finalPrice = basePrice * (1 - discountPercentage / 100);
    }

    return {
      basePrice,
      finalPrice,
      originalPrice: originalRetailPrice,
      wholesalePrice: calculatedWholesalePrice,
      discountPercentage,
      hasDiscount: discountPercentage > 0,
      isWholesale,
    };
  }

  /**
   * Calculate option price based on customer type and discounts
   */
  calculateOptionPrice(
    standardPrice: number | null,
    wholesalePrice: number | null,
    baseOptionPrice: number,
    isWholesale: boolean,
    optionDiscount: number = 0,
    companyDiscount: number = 0,
  ): OptionPricingResult {
    // Determine base price based on customer type
    let basePrice = parseFloat(baseOptionPrice.toString()) || 0;
    
    if (isWholesale && wholesalePrice !== null && wholesalePrice !== undefined) {
      basePrice = parseFloat(wholesalePrice.toString());
    } else if (!isWholesale && standardPrice !== null && standardPrice !== undefined) {
      basePrice = parseFloat(standardPrice.toString());
    }

    let finalPrice = basePrice;
    let discountPercentage = 0;
    const effectiveDiscount = isWholesale && companyDiscount > 0 ? companyDiscount : optionDiscount;
    if (effectiveDiscount > 0) {
      discountPercentage = effectiveDiscount;
      finalPrice = basePrice * (1 - discountPercentage / 100);
    }

    return {
      basePrice,
      finalPrice,
      discountPercentage,
      hasDiscount: discountPercentage > 0,
    };
  }

  /**
   * Calculate total for a product with options
   */
  calculateProductTotal(
    productPricing: PricingResult,
    quantity: number,
    options: Array<{ option_price: number; option_quantity: number }>,
  ): number {
    let total = productPricing.finalPrice * quantity;

    // Add option prices
    if (options && Array.isArray(options)) {
      for (const option of options) {
        const optionPrice = parseFloat(option.option_price?.toString() || '0');
        const optionQuantity = parseInt(option.option_quantity?.toString() || '1');
        total += optionPrice * optionQuantity;
      }
    }

    return total;
  }
}

