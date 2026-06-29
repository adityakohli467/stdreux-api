import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { PricingService } from '../../common/services/pricing.service';

@Injectable()
export class StoreProductsService {
  private readonly logger = new Logger(StoreProductsService.name);

  constructor(
    private dataSource: DataSource,
    private jwtService: JwtService,
    private pricingService: PricingService,
  ) { }

  /**
   * Get customer discount percentage
   */
  private async getCustomerDiscount(userId: number): Promise<number> {
    try {
      if (!userId) return 0;

      // Check which discount column exists
      const columnCheck = await this.dataSource.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'customer' 
        AND column_name IN ('discount_percentage', 'wholesale_discount_percentage')
      `);
      const hasDiscountPercentage = columnCheck.some((row: any) => row.column_name === 'discount_percentage');
      const hasWholesaleDiscountPercentage = columnCheck.some((row: any) => row.column_name === 'wholesale_discount_percentage');

      const discountColumn = hasDiscountPercentage ? 'c.discount_percentage' :
        hasWholesaleDiscountPercentage ? 'c.wholesale_discount_percentage' : 'NULL';

      const customerQuery = `
        SELECT 
          c.customer_type, 
          ${discountColumn} as discount_percentage
        FROM customer c
        WHERE c.user_id = $1
      `;
      const customerResult = await this.dataSource.query(customerQuery, [userId]);
      const customer = customerResult[0];

      if (!customer) return 0;

      // If custom discount percentage is set, use it
      if (customer.discount_percentage !== null && customer.discount_percentage !== undefined) {
        const discount = parseFloat(customer.discount_percentage.toString());
        if (!isNaN(discount) && discount > 0) {
          return discount;
        }
      }

      // No default discount - must be explicitly set per customer
      return 0;
    } catch (error) {
      this.logger.error('Error getting customer discount:', error);
      return 0;
    }
  }

  /**
   * Extract user ID from JWT token
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
   * Check whether the customer linked to the given userId is a VIP.
   * VIP customers can see priority-access products before their expiry date.
   */
  private async isVipCustomer(userId: number | null): Promise<boolean> {
    if (!userId) return false;
    try {
      const colCheck = await this.dataSource.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customer' AND column_name = 'vip' LIMIT 1
      `);
      if (colCheck.length === 0) return false;
      const result = await this.dataSource.query(
        `SELECT COALESCE(vip, false) AS vip FROM customer WHERE user_id = $1`,
        [userId],
      );
      return result.length > 0 && result[0].vip === true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Build a SQL fragment (prefixed with " AND ...") that hides priority-access
   * products from non-VIP customers (and guests) until their expiry date passes.
   * Returns '' for VIP customers (who see everything) or when the priority_access
   * column does not exist yet.
   * Use the same alias `p` for the product table in the target query.
   */
  private async getPriorityAccessFilter(isVip: boolean): Promise<string> {
    if (isVip) return '';
    const colCheck = await this.dataSource.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'product' AND column_name IN ('priority_access', 'priority_access_expiry')
    `);
    const hasPriority = colCheck.some((r: any) => r.column_name === 'priority_access');
    const hasExpiry = colCheck.some((r: any) => r.column_name === 'priority_access_expiry');
    if (!hasPriority) return '';
    // A product is restricted (VIP-only) while priority_access is on AND the expiry
    // is still in the future (or not set). Once the expiry date is reached, the
    // daily cron flips the flag and the product becomes visible to everyone.
    const stillRestricted = hasExpiry
      ? `(p.priority_access_expiry IS NULL OR p.priority_access_expiry > CURRENT_DATE)`
      : `true`;
    return ` AND NOT (COALESCE(p.priority_access, false) = true AND ${stillRestricted})`;
  }

  /**
   * List products for storefront with filters
   */
  async listProducts(
    filters: {
      page?: number;
      limit?: number;
      search?: string;
      category_id?: number;
      subcategory_id?: number;
      heading_id?: number;
      min_price?: number;
      max_price?: number;
      order_by?: string;
    },
    authHeader?: string,
  ) {
    const {
      page = 1,
      limit = 20,
      search,
      category_id,
      subcategory_id,
      heading_id,
      min_price,
      max_price,
      order_by = 'featured',
    } = filters;

    // Get user from token if provided
    let userId: number | null = null;
    let discountPercentage = 0;
    let customerType: string | null = null;

    userId = this.extractUserIdFromToken(authHeader);
    if (userId) {
      discountPercentage = await this.getCustomerDiscount(userId);
      const customerTypeQuery = await this.dataSource.query(
        `SELECT customer_type FROM customer WHERE user_id = $1`,
        [userId],
      );
      if (customerTypeQuery.length > 0) {
        customerType = customerTypeQuery[0].customer_type || null;
      }
    }

    const isRetailer = customerType ? customerType.toLowerCase().trim() === 'retail' : false;
    const isWholesaler = customerType ? (
      customerType.toLowerCase().includes('wholesale') ||
      customerType.toLowerCase().includes('wholesaler') ||
      customerType.toLowerCase().startsWith('full service') ||
      customerType.toLowerCase().startsWith('partial service')
    ) : false;

    // Priority-access visibility: VIP customers see everything, others have
    // priority-access products hidden until their expiry date passes.
    const isVip = await this.isVipCustomer(userId);
    const priorityAccessFilter = await this.getPriorityAccessFilter(isVip);

    // Check if user_price column exists to avoid DB errors on environments without migrations
    const userPriceColumnCheck = await this.dataSource.query(`
      SELECT 1 
      FROM information_schema.columns 
      WHERE table_name = 'product' AND column_name = 'user_price'
      LIMIT 1
    `);
    const hasUserPriceColumn = userPriceColumnCheck.length > 0;
    const userPriceSelectClause = hasUserPriceColumn ? 'p.user_price' : 'NULL as user_price';
    const showInStoreColumnCheck = await this.dataSource.query(`
      SELECT 1 
      FROM information_schema.columns 
      WHERE table_name = 'product' AND column_name = 'show_in_store'
      LIMIT 1
    `);
    const hasShowInStoreColumn = showInStoreColumnCheck.length > 0;
    const showInStoreSelectClause = hasShowInStoreColumn ? 'p.show_in_store' : 'NULL as show_in_store';
    const addToSubscriptionColumnCheck = await this.dataSource.query(`
      SELECT 1 
      FROM information_schema.columns 
      WHERE table_name = 'product' AND column_name = 'add_to_subscription'
      LIMIT 1
    `);
    const hasAddToSubscriptionColumn = addToSubscriptionColumnCheck.length > 0;
    const addToSubscriptionSelectClause = hasAddToSubscriptionColumn ? 'p.add_to_subscription' : 'NULL as add_to_subscription';

    // Check for premium pricing columns
    const premiumColumnsCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'product' 
      AND column_name IN ('premium_discount_percentage', 'product_price_premium', 'premium_price_discounted')
    `);
    const hasPremiumDiscountPercentage = premiumColumnsCheck.some((row: any) => row.column_name === 'premium_discount_percentage');
    const hasProductPricePremium = premiumColumnsCheck.some((row: any) => row.column_name === 'product_price_premium');
    const hasPremiumPriceDiscounted = premiumColumnsCheck.some((row: any) => row.column_name === 'premium_price_discounted');

    const premiumDiscountPercentageSelectClause = hasPremiumDiscountPercentage ? 'p.premium_discount_percentage' : 'NULL as premium_discount_percentage';
    const productPricePremiumSelectClause = hasProductPricePremium ? 'p.product_price_premium' : 'NULL as product_price_premium';
    const premiumPriceDiscountedSelectClause = hasPremiumPriceDiscounted ? 'p.premium_price_discounted' : 'NULL as premium_price_discounted';

    const offset = (Number(page) - 1) * Number(limit);
    const params: any[] = [];
    let paramIndex = 1;

    let query = `
      SELECT 
        p.product_id,
        p.product_name,
        p.product_description,
        p.product_price,
        p.retail_price,
        ${userPriceSelectClause},
        ${showInStoreSelectClause},
        ${addToSubscriptionSelectClause},
        ${premiumDiscountPercentageSelectClause},
        ${productPricePremiumSelectClause},
        ${premiumPriceDiscountedSelectClause},
        p.customer_type_visibility,
        p.product_image,
        p.product_status,
        p.product_date_added,
        p.subcategory_id,
        ph.heading as header_name,
        array_agg(DISTINCT pc.category_id) FILTER (WHERE pc.category_id IS NOT NULL) as categories,
        (
          SELECT json_build_object(
            'category_id', sc.category_id,
            'category_name', sc.category_name,
            'parent_category_id', sc.parent_category_id
          )
          FROM category sc
          WHERE sc.category_id = p.subcategory_id
        ) as subcategory,
        (
          SELECT json_agg(
            json_build_object(
              'product_image_id', pi.product_image_id,
              'image_url', pi.image_url,
              'image_order', pi.image_order
            ) ORDER BY pi.image_order
          )
          FROM product_images pi
          WHERE pi.product_id = p.product_id
        ) as product_images,
        (
          SELECT json_agg(
            json_build_object(
              'product_option_id', po.product_option_id,
              'option_id', o.option_id,
              'option_name', o.name,
              'option_type', o.option_type,
              'option_value_id', ov.option_value_id,
              'option_value', ov.name,
              'standard_price', ov.standard_price,
              'wholesale_price', ov.wholesale_price,
              'wholesale_price_premium', ov.wholesale_price_premium,
              'sort_order', ov.sort_order,
              'required', po.option_required,
              'product_option_price', po.option_price,
              'product_option_price_prefix', po.option_price_prefix
            ) ORDER BY o.option_id, ov.sort_order
          )
          FROM product_option po
          JOIN option_value ov ON po.option_value_id = ov.option_value_id
          JOIN options o ON ov.option_id = o.option_id
          WHERE po.product_id = p.product_id
        ) as options
      FROM product p
      LEFT JOIN heading_product hp ON p.product_id = hp.product_id
      LEFT JOIN product_header ph ON hp.heading_id = ph.heading_id
      LEFT JOIN product_category pc ON p.product_id = pc.product_id
      WHERE p.product_status = 1
    `;

    // Filter by customer type visibility
    if (userId && customerType) {
      if (isRetailer) {
        query += ` AND (LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'all' OR LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'retailers')`;
      } else if (isWholesaler) {
        query += ` AND (LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'all' OR LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'wholesalers')`;
      } else {
        query += ` AND LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'all'`;
      }
    } else {
      query += ` AND LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'all'`;
    }

    // Hide priority-access products from non-VIP customers until expiry
    query += priorityAccessFilter;

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (p.product_name ILIKE $${paramIndex} OR p.product_description ILIKE $${paramIndex})`;
      paramIndex++;
    }

    if (category_id) {
      params.push(Number(category_id));
      query += ` AND pc.category_id = $${paramIndex}`;
      paramIndex++;
    }

    if (subcategory_id) {
      params.push(Number(subcategory_id));
      query += ` AND p.subcategory_id = $${paramIndex}`;
      paramIndex++;
    }

    if (heading_id) {
      params.push(Number(heading_id));
      query += ` AND hp.heading_id = $${paramIndex}`;
      paramIndex++;
    }

    if (min_price) {
      params.push(Number(min_price));
      query += ` AND p.product_price >= $${paramIndex}`;
      paramIndex++;
    }

    if (max_price) {
      params.push(Number(max_price));
      query += ` AND p.product_price <= $${paramIndex}`;
      paramIndex++;
    }

    // Determine sort order
    let orderByClause: string;
    if (order_by === 'price-low') {
      orderByClause = 'ORDER BY p.product_price ASC';
    } else if (order_by === 'price-high') {
      orderByClause = 'ORDER BY p.product_price DESC';
    } else if (order_by === 'newest') {
      orderByClause = 'ORDER BY p.product_date_added DESC';
    } else {
      orderByClause = 'ORDER BY p.product_id DESC';
    }

    query += `
      GROUP BY p.product_id, p.product_name, p.product_description, p.product_price, 
               p.retail_price, p.customer_type_visibility, p.product_image, p.product_status, p.product_date_added, p.subcategory_id, ph.heading${hasUserPriceColumn ? ', p.user_price' : ''}${hasShowInStoreColumn ? ', p.show_in_store' : ''}${hasAddToSubscriptionColumn ? ', p.add_to_subscription' : ''}${hasPremiumDiscountPercentage ? ', p.premium_discount_percentage' : ''}${hasProductPricePremium ? ', p.product_price_premium' : ''}${hasPremiumPriceDiscounted ? ', p.premium_price_discounted' : ''}
      ${orderByClause}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(Number(limit), offset);

    const result = await this.dataSource.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(DISTINCT p.product_id) as total
      FROM product p
      LEFT JOIN product_category pc ON p.product_id = pc.product_id
      LEFT JOIN heading_product hp ON p.product_id = hp.product_id
      WHERE p.product_status = 1
    `;

    let countParams: any[] = [];
    let countParamIndex = 1;

    if (search) {
      countParams.push(`%${search}%`);
      countQuery += ` AND (p.product_name ILIKE $${countParamIndex} OR p.product_description ILIKE $${countParamIndex})`;
      countParamIndex++;
    }

    if (category_id) {
      countParams.push(Number(category_id));
      countQuery += ` AND pc.category_id = $${countParamIndex}`;
      countParamIndex++;
    }

    if (subcategory_id) {
      countParams.push(Number(subcategory_id));
      countQuery += ` AND p.subcategory_id = $${countParamIndex}`;
      countParamIndex++;
    }

    if (heading_id) {
      countParams.push(Number(heading_id));
      countQuery += ` AND hp.heading_id = $${countParamIndex}`;
      countParamIndex++;
    }

    if (min_price) {
      countParams.push(Number(min_price));
      countQuery += ` AND p.product_price >= $${countParamIndex}`;
      countParamIndex++;
    }

    if (max_price) {
      countParams.push(Number(max_price));
      countQuery += ` AND p.product_price <= $${countParamIndex}`;
      countParamIndex++;
    }

    // Apply same visibility filter to count query
    if (userId && customerType) {
      if (isRetailer) {
        countQuery += ` AND (LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'all' OR LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'retailers')`;
      } else if (isWholesaler) {
        countQuery += ` AND (LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'all' OR LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'wholesalers')`;
      } else {
        countQuery += ` AND LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'all'`;
      }
    } else {
      countQuery += ` AND LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'all'`;
    }

    // Hide priority-access products from non-VIP customers until expiry
    countQuery += priorityAccessFilter;

    const countResult = await this.dataSource.query(countQuery, countParams);
    const total = parseInt(countResult[0].total);

    // Get customer ID and discounts
    let customerId: number | null = null;
    let productDiscountsMap = new Map<number, number>();
    let companyProductDiscountsMap = new Map<number, number>();

    if (userId) {
      try {
        // Get customer_id from user_id
        const customerQuery = await this.dataSource.query(
          `SELECT customer_id FROM customer WHERE user_id = $1`,
          [userId],
        );
        if (customerQuery.length > 0) {
          customerId = customerQuery[0].customer_id;

          // Get product-level discounts from customer_product_discount table
          const productDiscountQuery = `
            SELECT product_id, discount_percentage
            FROM customer_product_discount
            WHERE customer_id = $1
          `;
          const productDiscountResult = await this.dataSource.query(productDiscountQuery, [customerId]);
          productDiscountResult.forEach((row: any) => {
            if (row.discount_percentage > 0) {
              productDiscountsMap.set(row.product_id, parseFloat(row.discount_percentage));
            }
          });

          // Get company-level discounts (override customer/wholesale/retail pricing)
          const companyId = await this.pricingService.getCompanyIdForCustomer(customerId);
          if (companyId) {
            const companyDiscounts = await this.pricingService.getCompanyDiscounts(companyId);
            companyProductDiscountsMap = companyDiscounts.productDiscounts;
          }
        }
      } catch (error) {
        this.logger.error('Error fetching customer discounts:', error);
      }
    }

    // Apply pricing based on customer type and discounts
    const productsWithDiscount = result.map((product: any) => {
      const retailPrice = parseFloat(product.product_price || 0);
      const wholesalePrice = product.retail_price ? parseFloat(product.retail_price || 0) : null;
      const retailDiscountPercentage = product.retail_discount_percentage ? parseFloat(product.retail_discount_percentage) : null;
      const userPrice = product.user_price ? parseFloat(product.user_price) : null;

      const premiumDiscountPercentage = product.premium_discount_percentage ? parseFloat(product.premium_discount_percentage) : null;
      const productPricePremium = product.product_price_premium ? parseFloat(product.product_price_premium) : null;
      const premiumPriceDiscounted = product.premium_price_discounted ? parseFloat(product.premium_price_discounted) : null;

      const premiumFields = {
        premium_discount_percentage: premiumDiscountPercentage !== null ? premiumDiscountPercentage.toFixed(2) : '0.00',
        product_price_premium: productPricePremium !== null ? productPricePremium.toFixed(2) : '0.00',
        premium_price_discounted: premiumPriceDiscounted !== null ? premiumPriceDiscounted.toFixed(2) : '0.00',
      };

      // Get product-level discount (prioritize customer_product_discount over general discount)
      const productDiscount = productDiscountsMap.get(product.product_id) || 0;
      const companyDiscount = companyProductDiscountsMap.get(product.product_id) || 0;

      // Use pricing service for consistent calculations
      const pricing = this.pricingService.calculateProductPrice(
        retailPrice,
        wholesalePrice,
        retailDiscountPercentage,
        isWholesaler,
        productDiscount,
        userPrice,
        companyDiscount,
      );

      // Map options
      let mappedOptions: any[] | null = null;
      if (product.options && Array.isArray(product.options)) {
        const optionsMap = new Map();
        for (const optVal of product.options) {
          if (!optionsMap.has(optVal.option_id)) {
            optionsMap.set(optVal.option_id, {
              option_id: optVal.option_id,
              option_name: optVal.option_name,
              option_type: optVal.option_type,
              required: optVal.required === 1,
              values: [],
            });
          }
          const option = optionsMap.get(optVal.option_id);
          const baseOptionPrice = parseFloat(optVal.product_option_price || 0);

          // Simple option pricing for the list
          let finalOptionPrice = baseOptionPrice;
          if (isWholesaler) {
            const wholesaleOptionPrice = optVal.wholesale_price !== null ? parseFloat(optVal.wholesale_price) : null;
            if (wholesaleOptionPrice !== null && !isNaN(wholesaleOptionPrice)) {
              finalOptionPrice = wholesaleOptionPrice;
            } else if (retailDiscountPercentage !== null && retailDiscountPercentage > 0) {
              finalOptionPrice = baseOptionPrice * (1 - retailDiscountPercentage / 100);
            }
          }

          option.values.push({
            ...optVal,
            product_option_price: finalOptionPrice,
            original_option_price: baseOptionPrice,
            discounted_option_price: finalOptionPrice,
            has_discount: finalOptionPrice < baseOptionPrice,
          });
        }
        mappedOptions = Array.from(optionsMap.values());
      }

      return {
        ...product,
        product_price: pricing.finalPrice.toFixed(2),
        original_price: pricing.originalPrice,
        discounted_price: pricing.finalPrice,
        discount_percentage: pricing.discountPercentage,
        has_discount: pricing.hasDiscount,
        wholesale_price: pricing.wholesalePrice,
        base_price: pricing.basePrice,
        is_wholesale: pricing.isWholesale,
        ...premiumFields,
        options: mappedOptions,
      };
    });

    return {
      products: productsWithDiscount,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        total_pages: Math.ceil(total / Number(limit)),
      },
    };
  }

  /**
   * Get product details with options
   */
  async getProduct(id: number, authHeader?: string) {
    // Get user from token if provided
    let userId: number | null = null;
    let discountPercentage = 0;
    let customerType: string | null = null;

    userId = this.extractUserIdFromToken(authHeader);
    if (userId) {
      discountPercentage = await this.getCustomerDiscount(userId);
      const customerTypeQuery = await this.dataSource.query(
        `SELECT customer_type FROM customer WHERE user_id = $1`,
        [userId],
      );
      if (customerTypeQuery.length > 0) {
        customerType = customerTypeQuery[0].customer_type || null;
      }
    }

    const isRetailer = customerType ? customerType.toLowerCase().trim() === 'retail' : false;
    const isWholesaler = customerType ? (
      customerType.toLowerCase().includes('wholesale') ||
      customerType.toLowerCase().includes('wholesaler') ||
      customerType.toLowerCase().startsWith('full service') ||
      customerType.toLowerCase().startsWith('partial service')
    ) : false;

    // Get product details
    let productQuery = `
      SELECT 
        p.*,
        ph.heading as header_name,
        ph.image as header_image,
        (
          SELECT json_agg(
            json_build_object(
              'product_image_id', pi.product_image_id,
              'image_url', pi.image_url,
              'image_order', pi.image_order
            ) ORDER BY pi.image_order
          )
          FROM product_images pi
          WHERE pi.product_id = p.product_id
        ) as product_images
      FROM product p
      LEFT JOIN heading_product hp ON p.product_id = hp.product_id
      LEFT JOIN product_header ph ON hp.heading_id = ph.heading_id
      WHERE p.product_id = $1 AND p.product_status = 1
    `;

    // Filter by customer type visibility
    if (userId && customerType) {
      if (isRetailer) {
        productQuery += ` AND (COALESCE(p.customer_type_visibility, 'all') = 'all' OR COALESCE(p.customer_type_visibility, 'all') = 'retailers')`;
      } else if (isWholesaler) {
        productQuery += ` AND (LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'all' OR LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'wholesalers')`;
      } else {
        productQuery += ` AND COALESCE(p.customer_type_visibility, 'all') = 'all'`;
      }
    } else {
      productQuery += ` AND COALESCE(p.customer_type_visibility, 'all') = 'all'`;
    }

    // Hide priority-access products from non-VIP customers until expiry
    const isVip = await this.isVipCustomer(userId);
    productQuery += await this.getPriorityAccessFilter(isVip);

    const productResult = await this.dataSource.query(productQuery, [id]);
    const product = productResult[0];

    if (!product) {
      throw new NotFoundException('Product not found or not available for your customer type');
    }

    // Get product categories
    const categoriesQuery = `
      SELECT 
        c.category_id,
        c.category_name,
        c.parent_category_id,
        COALESCE(c.gst_free, false) as gst_free
      FROM category c
      JOIN product_category pc ON c.category_id = pc.category_id
      WHERE pc.product_id = $1
    `;
    const categoriesResult = await this.dataSource.query(categoriesQuery, [id]);

    // Get product options
    const optionsQuery = `
      SELECT DISTINCT
        o.option_id,
        o.name as option_name,
        ov.option_value_id,
        ov.name as option_value,
        ov.standard_price as standard_price,
        ov.wholesale_price as wholesale_price,
        ov.wholesale_price_premium as wholesale_price_premium,
        ov.sort_order,
        o.option_type,
        po.product_option_id,
        po.option_required as required,
        po.option_price as product_option_price_base,
        po.option_price_prefix as product_option_price_prefix,
        p.retail_discount_percentage
      FROM product_option po
      JOIN option_value ov ON po.option_value_id = ov.option_value_id
      JOIN options o ON ov.option_id = o.option_id
      JOIN product p ON po.product_id = p.product_id
      WHERE po.product_id = $1
      ORDER BY o.option_id, ov.sort_order
    `;
    const optionsResult = await this.dataSource.query(optionsQuery, [id]);

    // Group options by option_id
    const optionsMap = new Map();
    for (const row of optionsResult) {
      if (!optionsMap.has(row.option_id)) {
        optionsMap.set(row.option_id, {
          option_id: row.option_id,
          option_name: row.option_name,
          option_type: row.option_type,
          required: row.required === 1,
          values: [],
        });
      }
      const option = optionsMap.get(row.option_id);

      const baseOptionPrice = parseFloat(row.product_option_price_base || 0);

      option.values.push({
        option_value_id: row.option_value_id,
        option_id: row.option_id,
        option_value: row.option_value,
        standard_price: row.standard_price,
        wholesale_price: row.wholesale_price,
        wholesale_price_premium: row.wholesale_price_premium,
        sort_order: row.sort_order,
        product_option_id: row.product_option_id,
        product_option_price: baseOptionPrice,
        product_option_price_prefix: row.product_option_price_prefix,
      });
    }
    const options = Array.from(optionsMap.values());

    // Get customer ID and discounts
    let customerId: number | null = null;
    let productDiscount = 0;
    let companyProductDiscount = 0;
    const optionDiscountsMap = new Map<number, number>();
    const companyOptionDiscountsMap = new Map<number, number>();

    if (userId) {
      try {
        // Get customer_id from user_id
        const customerQuery = await this.dataSource.query(
          `SELECT customer_id FROM customer WHERE user_id = $1`,
          [userId],
        );
        if (customerQuery.length > 0) {
          customerId = customerQuery[0].customer_id;

          // Get product-level discount from customer_product_discount table
          const productDiscountQuery = `
            SELECT discount_percentage
            FROM customer_product_discount
            WHERE customer_id = $1 AND product_id = $2
          `;
          const productDiscountResult = await this.dataSource.query(productDiscountQuery, [customerId, id]);
          if (productDiscountResult.length > 0 && productDiscountResult[0].discount_percentage > 0) {
            productDiscount = parseFloat(productDiscountResult[0].discount_percentage);
          }

          // Get option-level discounts
          const optionDiscountQuery = `
            SELECT option_value_id, discount_percentage
            FROM customer_product_option_discount
            WHERE customer_id = $1 AND product_id = $2
          `;
          const optionDiscountResult = await this.dataSource.query(optionDiscountQuery, [customerId, id]);
          optionDiscountResult.forEach((row: any) => {
            if (row.discount_percentage > 0) {
              optionDiscountsMap.set(row.option_value_id, parseFloat(row.discount_percentage));
            }
          });

          // Get company-level discounts (override customer/wholesale/retail pricing)
          const companyId = await this.pricingService.getCompanyIdForCustomer(customerId);
          if (companyId) {
            const companyDiscounts = await this.pricingService.getCompanyDiscounts(companyId);
            companyProductDiscount = companyDiscounts.productDiscounts.get(Number(id)) || 0;
            companyDiscounts.optionDiscounts.forEach((value, key) => {
              const [pid, optId] = key.split('_').map((v) => parseInt(v));
              if (pid === Number(id) && optId) {
                companyOptionDiscountsMap.set(optId, value);
              }
            });
          }
        }
      } catch (error) {
        this.logger.error('Error fetching customer discounts:', error);
      }
    }

    const retailPrice = parseFloat(product.product_price || 0);
    const wholesalePrice = product.retail_price ? parseFloat(product.retail_price || 0) : null;
    const retailDiscountPercentage = product.retail_discount_percentage ? parseFloat(product.retail_discount_percentage) : null;
    const userPrice = product.user_price ? parseFloat(product.user_price) : null;

    // Use pricing service for consistent calculations
    const pricing = this.pricingService.calculateProductPrice(
      retailPrice,
      wholesalePrice,
      retailDiscountPercentage,
      isWholesaler,
      productDiscount,
      userPrice,
      companyProductDiscount,
    );

    // Apply option discounts using pricing service
    const optionsWithPricing = options.map((option: any) => ({
      ...option,
      values: option.values.map((value: any) => {
        let baseOptionPrice = parseFloat(value.product_option_price || 0);
        const standardPrice = null;
        const optionWholesalePrice = value.wholesale_price !== null && value.wholesale_price !== undefined
          ? parseFloat(value.wholesale_price)
          : null;
        const optionDiscount = optionDiscountsMap.get(value.option_value_id) || 0;
        const companyOptionDiscount = companyOptionDiscountsMap.get(value.option_value_id) || 0;

        if (isWholesaler && (optionWholesalePrice === null || isNaN(optionWholesalePrice))) {
          if (retailDiscountPercentage !== null && retailDiscountPercentage !== undefined && retailDiscountPercentage > 0) {
            baseOptionPrice = baseOptionPrice * (1 - retailDiscountPercentage / 100);
          }
        }

        const optionPricing = this.pricingService.calculateOptionPrice(
          standardPrice,
          optionWholesalePrice,
          baseOptionPrice,
          isWholesaler,
          optionDiscount,
          companyOptionDiscount,
        );

        return {
          ...value,
          product_option_price: optionPricing.finalPrice,
          original_option_price: optionPricing.basePrice,
          discounted_option_price: optionPricing.finalPrice,
          discount_percentage: optionPricing.discountPercentage,
          has_discount: optionPricing.hasDiscount,
        };
      }),
    }));

    const productWithDiscount = {
      ...product,
      premium_discount_percentage: product.premium_discount_percentage ? parseFloat(product.premium_discount_percentage).toFixed(2) : '0.00',
      product_price_premium: product.product_price_premium ? parseFloat(product.product_price_premium).toFixed(2) : '0.00',
      premium_price_discounted: product.premium_price_discounted ? parseFloat(product.premium_price_discounted).toFixed(2) : '0.00',
      product_price: pricing.finalPrice.toFixed(2),
      original_price: pricing.originalPrice,
      discounted_price: pricing.finalPrice,
      discount_percentage: pricing.discountPercentage,
      has_discount: pricing.hasDiscount,
      wholesale_price: pricing.wholesalePrice,
      base_price: pricing.basePrice,
      is_wholesale: pricing.isWholesale,
      categories: categoriesResult,
      options: optionsWithPricing,
    };

    return { product: productWithDiscount };
  }


  /**
   * Get all categories for storefront
   */
  async getCategories() {
    const query = `
      SELECT 
        category_id,
        parent_category_id,
        category_name,
        sort_order
      FROM category
      ORDER BY parent_category_id NULLS FIRST, COALESCE(sort_order, 999999), category_name
    `;

    const result = await this.dataSource.query(query);

    const categoriesMap = new Map();
    const rootCategories: any[] = [];

    result.forEach((cat: any) => {
      categoriesMap.set(cat.category_id, { ...cat, subcategories: [] });
    });

    result.forEach((cat: any) => {
      const category = categoriesMap.get(cat.category_id);
      if (cat.parent_category_id) {
        const parent = categoriesMap.get(cat.parent_category_id);
        if (parent) {
          parent.subcategories.push(category);
        }
      } else {
        rootCategories.push(category);
      }
    });

    rootCategories.sort((a: any, b: any) => {
      const sa = a.sort_order ?? 999999;
      const sb = b.sort_order ?? 999999;
      if (sa !== sb) return sa - sb;
      return String(a.category_name).localeCompare(String(b.category_name));
    });
    rootCategories.forEach((rc: any) => {
      rc.subcategories.sort((a: any, b: any) => {
        const sa = a.sort_order ?? 999999;
        const sb = b.sort_order ?? 999999;
        if (sa !== sb) return sa - sb;
        return String(a.category_name).localeCompare(String(b.category_name));
      });
    });

    const mapCategory = (cat: any): any => ({
      category_id: cat.category_id,
      category_name: cat.category_name,
      subcategories: (cat.subcategories || []).map((child: any) => mapCategory(child)),
    });

    return { categories: rootCategories.map((cat) => mapCategory(cat)) };
  }

  /**
   * Get product headers (sections)
   */
  async getHeaders() {
    const query = `
      SELECT 
        heading_id,
        heading,
        image
      FROM product_header
      ORDER BY heading_id
    `;

    const result = await this.dataSource.query(query);
    return { headers: result };
  }

  /**
   * Get featured/popular products
   */
  async getFeaturedProducts(limit: number = 8, authHeader?: string) {
    // Get user from token if provided
    let userId: number | null = null;
    let discountPercentage = 0;
    let customerType: string | null = null;

    userId = this.extractUserIdFromToken(authHeader);
    if (userId) {
      discountPercentage = await this.getCustomerDiscount(userId);
      const customerTypeQuery = await this.dataSource.query(
        `SELECT customer_type FROM customer WHERE user_id = $1`,
        [userId],
      );
      if (customerTypeQuery.length > 0) {
        customerType = customerTypeQuery[0].customer_type || null;
      }
    }

    const isRetailer = customerType ? customerType.toLowerCase().trim() === 'retail' : false;
    const isWholesaler = customerType ? (
      customerType.toLowerCase().includes('wholesale') ||
      customerType.toLowerCase().includes('wholesaler') ||
      customerType.toLowerCase().startsWith('full service') ||
      customerType.toLowerCase().startsWith('partial service')
    ) : false;

    const userPriceColumnCheck2 = await this.dataSource.query(`
      SELECT 1 
      FROM information_schema.columns 
      WHERE table_name = 'product' AND column_name = 'user_price'
      LIMIT 1
    `);
    const hasUserPriceColumn2 = userPriceColumnCheck2.length > 0;
    const userPriceSelectClause2 = hasUserPriceColumn2 ? 'p.user_price' : 'NULL as user_price';
    const showInStoreColumnCheck2 = await this.dataSource.query(`
      SELECT 1 
      FROM information_schema.columns 
      WHERE table_name = 'product' AND column_name = 'show_in_store'
      LIMIT 1
    `);
    const hasShowInStoreColumn2 = showInStoreColumnCheck2.length > 0;
    const showInStoreSelectClause2 = hasShowInStoreColumn2 ? 'p.show_in_store' : 'NULL as show_in_store';

    // Check for premium pricing columns for featured products
    const premiumColumnsCheckFeatured = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'product' 
      AND column_name IN ('premium_discount_percentage', 'product_price_premium', 'premium_price_discounted')
    `);
    const hasPremiumDiscountPercentage2 = premiumColumnsCheckFeatured.some((row: any) => row.column_name === 'premium_discount_percentage');
    const hasProductPricePremium2 = premiumColumnsCheckFeatured.some((row: any) => row.column_name === 'product_price_premium');
    const hasPremiumPriceDiscounted2 = premiumColumnsCheckFeatured.some((row: any) => row.column_name === 'premium_price_discounted');

    const premiumDiscountPercentageSelectClause2 = hasPremiumDiscountPercentage2 ? 'p.premium_discount_percentage' : 'NULL as premium_discount_percentage';
    const productPricePremiumSelectClause2 = hasProductPricePremium2 ? 'p.product_price_premium' : 'NULL as product_price_premium';
    const premiumPriceDiscountedSelectClause2 = hasPremiumPriceDiscounted2 ? 'p.premium_price_discounted' : 'NULL as premium_price_discounted';

    let query = `
      SELECT 
        p.product_id,
        p.product_name,
        p.product_description,
        p.product_price,
        p.retail_price,
        ${userPriceSelectClause2},
        ${showInStoreSelectClause2},
        ${premiumDiscountPercentageSelectClause2},
        ${productPricePremiumSelectClause2},
        ${premiumPriceDiscountedSelectClause2},
        p.customer_type_visibility,
        p.product_image,
        p.product_status,
        ph.heading as header_name,
        (
          SELECT json_agg(
            json_build_object(
              'product_image_id', pi.product_image_id,
              'image_url', pi.image_url,
              'image_order', pi.image_order
            ) ORDER BY pi.image_order
          )
          FROM product_images pi
          WHERE pi.product_id = p.product_id
        ) as product_images,
        (
          SELECT json_agg(
            json_build_object(
              'product_option_id', po.product_option_id,
              'option_id', o.option_id,
              'option_name', o.name,
              'option_type', o.option_type,
              'option_value_id', ov.option_value_id,
              'option_value', ov.name,
              'standard_price', ov.standard_price,
              'wholesale_price', ov.wholesale_price,
              'wholesale_price_premium', ov.wholesale_price_premium,
              'sort_order', ov.sort_order,
              'required', po.option_required,
              'product_option_price', po.option_price,
              'product_option_price_prefix', po.option_price_prefix
            ) ORDER BY o.option_id, ov.sort_order
          )
          FROM product_option po
          JOIN option_value ov ON po.option_value_id = ov.option_value_id
          JOIN options o ON ov.option_id = o.option_id
          WHERE po.product_id = p.product_id
        ) as options
      FROM product p
      LEFT JOIN heading_product hp ON p.product_id = hp.product_id
      LEFT JOIN product_header ph ON hp.heading_id = ph.heading_id
      WHERE p.product_status = 1
    `;

    // Filter by customer type visibility
    if (userId && customerType) {
      if (isRetailer) {
        query += ` AND (COALESCE(p.customer_type_visibility, 'all') = 'all' OR COALESCE(p.customer_type_visibility, 'all') = 'retailers')`;
      } else if (isWholesaler) {
        query += ` AND (LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'all' OR LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'wholesalers')`;
      } else {
        query += ` AND COALESCE(p.customer_type_visibility, 'all') = 'all'`;
      }
    } else {
      query += ` AND COALESCE(p.customer_type_visibility, 'all') = 'all'`;
    }

    // Hide priority-access products from non-VIP customers until expiry
    query += await this.getPriorityAccessFilter(await this.isVipCustomer(userId));

    // Check if featured_1 and featured_2 columns exist
    const featuredCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'product' 
      AND column_name IN ('featured_1', 'featured_2')
    `);
    const hasFeatured1 = featuredCheck.some((row: any) => row.column_name === 'featured_1');
    const hasFeatured2 = featuredCheck.some((row: any) => row.column_name === 'featured_2');

    query += `
      GROUP BY p.product_id, p.product_name, p.product_description, p.product_price, 
               p.retail_price, p.customer_type_visibility, p.product_image, p.product_status, ph.heading${hasUserPriceColumn2 ? ', p.user_price' : ''}${hasShowInStoreColumn2 ? ', p.show_in_store' : ''}${hasPremiumDiscountPercentage2 ? ', p.premium_discount_percentage' : ''}${hasProductPricePremium2 ? ', p.product_price_premium' : ''}${hasPremiumPriceDiscounted2 ? ', p.premium_price_discounted' : ''}
      ORDER BY p.product_id DESC
      LIMIT $1
    `;

    const result = await this.dataSource.query(query, [Number(limit)]);

    // Get product-specific discounts
    let productDiscountsMap = new Map<number, number>();
    if (userId) {
      try {
        const productDiscountQuery = `
          SELECT DISTINCT product_id, MAX(discount_percentage) as max_discount
          FROM customer_product_option_discount
          WHERE customer_id = (
            SELECT customer_id FROM customer WHERE user_id = $1
          )
          GROUP BY product_id
        `;
        const productDiscountResult = await this.dataSource.query(productDiscountQuery, [userId]);
        productDiscountResult.forEach((row: any) => {
          if (row.max_discount > 0) {
            productDiscountsMap.set(row.product_id, row.max_discount);
          }
        });
      } catch (error) {
        this.logger.error('Error fetching product-specific discounts:', error);
      }
    }

    // Apply pricing
    const productsWithDiscount = result.map((product: any) => {
      const retailPrice = parseFloat(product.product_price || 0);
      let wholesalePrice: number;
      if (product.retail_price) {
        wholesalePrice = parseFloat(product.retail_price || 0);
      } else {
        wholesalePrice = retailPrice; // No default discount - use retail price if wholesale price not set
      }

      const productSpecificDiscount = productDiscountsMap.get(product.product_id) || 0;
      const effectiveDiscount = productSpecificDiscount > 0 ? productSpecificDiscount : discountPercentage;

      const premiumDiscountPercentage = product.premium_discount_percentage ? parseFloat(product.premium_discount_percentage) : null;
      const productPricePremium = product.product_price_premium ? parseFloat(product.product_price_premium) : null;
      const premiumPriceDiscounted = product.premium_price_discounted ? parseFloat(product.premium_price_discounted) : null;

      const premiumFields = {
        premium_discount_percentage: premiumDiscountPercentage !== null ? premiumDiscountPercentage.toFixed(2) : '0.00',
        product_price_premium: productPricePremium !== null ? productPricePremium.toFixed(2) : '0.00',
        premium_price_discounted: premiumPriceDiscounted !== null ? premiumPriceDiscounted.toFixed(2) : '0.00',
      };

      // Map options
      let mappedOptions: any[] | null = null;
      if (product.options && Array.isArray(product.options)) {
        const optionsMap = new Map();
        for (const optVal of product.options) {
          if (!optionsMap.has(optVal.option_id)) {
            optionsMap.set(optVal.option_id, {
              option_id: optVal.option_id,
              option_name: optVal.option_name,
              option_type: optVal.option_type,
              required: optVal.required === 1,
              values: [],
            });
          }
          const option = optionsMap.get(optVal.option_id);
          const baseOptionPrice = parseFloat(optVal.product_option_price || 0);

          let finalOptionPrice = baseOptionPrice;
          if (isWholesaler) {
            const wholesaleOptionPrice = optVal.wholesale_price !== null ? parseFloat(optVal.wholesale_price) : null;
            if (wholesaleOptionPrice !== null && !isNaN(wholesaleOptionPrice)) {
              finalOptionPrice = wholesaleOptionPrice;
            }
          }

          option.values.push({
            ...optVal,
            product_option_price: finalOptionPrice,
            original_option_price: baseOptionPrice,
            discounted_option_price: finalOptionPrice,
            has_discount: finalOptionPrice < baseOptionPrice,
          });
        }
        mappedOptions = Array.from(optionsMap.values());
      }

      if (isRetailer) {
        if (effectiveDiscount > 0 && retailPrice > 0) {
          const discountAmount = retailPrice * (effectiveDiscount / 100);
          const finalPrice = retailPrice - discountAmount;
          return {
            ...product,
            product_price: finalPrice.toFixed(2),
            original_price: retailPrice,
            discounted_price: parseFloat(finalPrice.toFixed(2)),
            discount_percentage: effectiveDiscount,
            has_discount: true,
            ...premiumFields,
            options: mappedOptions,
          };
        } else {
          return {
            ...product,
            product_price: retailPrice.toFixed(2),
            original_price: retailPrice,
            discounted_price: retailPrice,
            discount_percentage: 0,
            has_discount: false,
            ...premiumFields,
            options: mappedOptions,
          };
        }
      } else if (isWholesaler) {
        if (effectiveDiscount > 0 && wholesalePrice > 0) {
          const discountAmount = wholesalePrice * (effectiveDiscount / 100);
          const finalPrice = wholesalePrice - discountAmount;
          return {
            ...product,
            product_price: finalPrice.toFixed(2),
            original_price: wholesalePrice,
            discounted_price: parseFloat(finalPrice.toFixed(2)),
            discount_percentage: effectiveDiscount,
            has_discount: true,
            ...premiumFields,
            options: mappedOptions,
          };
        } else {
          return {
            ...product,
            product_price: wholesalePrice.toFixed(2),
            original_price: wholesalePrice,
            discounted_price: wholesalePrice,
            discount_percentage: 0,
            has_discount: false,
            ...premiumFields,
            options: mappedOptions,
          };
        }
      } else {
        return {
          ...product,
          product_price: retailPrice.toFixed(2),
          original_price: retailPrice,
          discounted_price: retailPrice,
          discount_percentage: 0,
          has_discount: false,
          ...premiumFields,
          options: mappedOptions,
        };
      }
    });

    return { products: productsWithDiscount };
  }

  /**
   * Get featured products by featured flag (featured_1 or featured_2)
   */
  async getFeaturedProductsByFlag(featuredFlag: 'featured_1' | 'featured_2', limit: number = 4, authHeader?: string) {
    // Get user from token if provided
    let userId: number | null = null;
    let discountPercentage = 0;
    let customerType: string | null = null;

    userId = this.extractUserIdFromToken(authHeader);
    if (userId) {
      discountPercentage = await this.getCustomerDiscount(userId);
      const customerTypeQuery = await this.dataSource.query(
        `SELECT customer_type FROM customer WHERE user_id = $1`,
        [userId],
      );
      if (customerTypeQuery.length > 0) {
        customerType = customerTypeQuery[0].customer_type || null;
      }
    }

    const isRetailer = customerType ? customerType.toLowerCase().trim() === 'retail' : false;
    const isWholesaler = customerType ? (
      customerType.toLowerCase().includes('wholesale') ||
      customerType.toLowerCase().includes('wholesaler') ||
      customerType.toLowerCase().startsWith('full service') ||
      customerType.toLowerCase().startsWith('partial service')
    ) : false;

    // Check if featured columns exist
    const featuredCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'product' 
      AND column_name IN ('featured_1', 'featured_2')
    `);
    const hasFeatured1 = featuredCheck.some((row: any) => row.column_name === 'featured_1');
    const hasFeatured2 = featuredCheck.some((row: any) => row.column_name === 'featured_2');

    if ((featuredFlag === 'featured_1' && !hasFeatured1) || (featuredFlag === 'featured_2' && !hasFeatured2)) {
      // Fallback to regular featured products if column doesn't exist
      return this.getFeaturedProducts(limit, authHeader);
    }

    const userPriceColumnCheck3 = await this.dataSource.query(`
      SELECT 1 
      FROM information_schema.columns 
      WHERE table_name = 'product' AND column_name = 'user_price'
      LIMIT 1
    `);
    const hasUserPriceColumn3 = userPriceColumnCheck3.length > 0;
    const userPriceSelectClause3 = hasUserPriceColumn3 ? 'p.user_price' : 'NULL as user_price';
    const showInStoreColumnCheck3 = await this.dataSource.query(`
      SELECT 1 
      FROM information_schema.columns 
      WHERE table_name = 'product' AND column_name = 'show_in_store'
      LIMIT 1
    `);
    const hasShowInStoreColumn3 = showInStoreColumnCheck3.length > 0;
    const showInStoreSelectClause3 = hasShowInStoreColumn3 ? 'p.show_in_store' : 'NULL as show_in_store';

    // Check for premium pricing columns in filtered query
    const premiumColumnsCheckFeatured3 = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'product' 
      AND column_name IN ('premium_discount_percentage', 'product_price_premium', 'premium_price_discounted')
    `);
    const hasPremiumDiscountPercentage3 = premiumColumnsCheckFeatured3.some((row: any) => row.column_name === 'premium_discount_percentage');
    const hasProductPricePremium3 = premiumColumnsCheckFeatured3.some((row: any) => row.column_name === 'product_price_premium');
    const hasPremiumPriceDiscounted3 = premiumColumnsCheckFeatured3.some((row: any) => row.column_name === 'premium_price_discounted');

    const premiumDiscountPercentageSelectClause3 = hasPremiumDiscountPercentage3 ? 'p.premium_discount_percentage' : 'NULL as premium_discount_percentage';
    const productPricePremiumSelectClause3 = hasProductPricePremium3 ? 'p.product_price_premium' : 'NULL as product_price_premium';
    const premiumPriceDiscountedSelectClause3 = hasPremiumPriceDiscounted3 ? 'p.premium_price_discounted' : 'NULL as premium_price_discounted';

    // Build query with proper column name - use string concatenation for column name
    const featuredColumn = featuredFlag === 'featured_1' ? 'featured_1' : 'featured_2';

    // Use proper SQL identifier quoting for column name
    let query = `
      SELECT 
        p.product_id,
        p.product_name,
        p.product_description,
        p.product_price,
        p.retail_price,
        ${userPriceSelectClause3},
        ${showInStoreSelectClause3},
        ${premiumDiscountPercentageSelectClause3},
        ${productPricePremiumSelectClause3},
        ${premiumPriceDiscountedSelectClause3},
        p.customer_type_visibility,
        p.product_image,
        p.product_status,
        ph.heading as header_name,
        (
          SELECT json_agg(
            json_build_object(
              'product_image_id', pi.product_image_id,
              'image_url', pi.image_url,
              'image_order', pi.image_order
            ) ORDER BY pi.image_order
          )
          FROM product_images pi
          WHERE pi.product_id = p.product_id
        ) as product_images,
        (
          SELECT json_agg(
            json_build_object(
              'product_option_id', po.product_option_id,
              'option_id', o.option_id,
              'option_name', o.name,
              'option_type', o.option_type,
              'option_value_id', ov.option_value_id,
              'option_value', ov.name,
              'standard_price', ov.standard_price,
              'wholesale_price', ov.wholesale_price,
              'wholesale_price_premium', ov.wholesale_price_premium,
              'sort_order', ov.sort_order,
              'required', po.option_required,
              'product_option_price', po.option_price,
              'product_option_price_prefix', po.option_price_prefix
            ) ORDER BY o.option_id, ov.sort_order
          )
          FROM product_option po
          JOIN option_value ov ON po.option_value_id = ov.option_value_id
          JOIN options o ON ov.option_id = o.option_id
          WHERE po.product_id = p.product_id
        ) as options
      FROM product p
      LEFT JOIN heading_product hp ON p.product_id = hp.product_id
      LEFT JOIN product_header ph ON hp.heading_id = ph.heading_id
      WHERE p.product_status = 1
        AND p.` + featuredColumn + ` = true
    `;

    // Filter by customer type visibility
    if (userId && customerType) {
      if (isRetailer) {
        query += ` AND (COALESCE(p.customer_type_visibility, 'all') = 'all' OR COALESCE(p.customer_type_visibility, 'all') = 'retailers')`;
      } else if (isWholesaler) {
        query += ` AND (LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'all' OR LOWER(COALESCE(p.customer_type_visibility, 'all')) = 'wholesalers')`;
      } else {
        query += ` AND COALESCE(p.customer_type_visibility, 'all') = 'all'`;
      }
    } else {
      query += ` AND COALESCE(p.customer_type_visibility, 'all') = 'all'`;
    }

    // Hide priority-access products from non-VIP customers until expiry
    query += await this.getPriorityAccessFilter(await this.isVipCustomer(userId));

    query += `
      GROUP BY p.product_id, p.product_name, p.product_description, p.product_price, 
               p.retail_price, p.customer_type_visibility, p.product_image, p.product_status, ph.heading${hasUserPriceColumn3 ? ', p.user_price' : ''}${hasShowInStoreColumn3 ? ', p.show_in_store' : ''}${hasPremiumDiscountPercentage3 ? ', p.premium_discount_percentage' : ''}${hasProductPricePremium3 ? ', p.product_price_premium' : ''}${hasPremiumPriceDiscounted3 ? ', p.premium_price_discounted' : ''}
      ORDER BY p.product_id DESC
      LIMIT $1
    `;

    const result = await this.dataSource.query(query, [Number(limit)]);

    // Get product-specific discounts
    let productDiscountsMap = new Map<number, number>();
    if (userId) {
      try {
        const productDiscountQuery = `
          SELECT DISTINCT product_id, MAX(discount_percentage) as max_discount
          FROM customer_product_option_discount
          WHERE customer_id = (
            SELECT customer_id FROM customer WHERE user_id = $1
          )
          GROUP BY product_id
        `;
        const productDiscountResult = await this.dataSource.query(productDiscountQuery, [userId]);
        productDiscountResult.forEach((row: any) => {
          if (row.max_discount > 0) {
            productDiscountsMap.set(row.product_id, row.max_discount);
          }
        });
      } catch (error) {
        this.logger.error('Error fetching product-specific discounts:', error);
      }
    }

    // Apply pricing (same logic as getFeaturedProducts)
    const productsWithDiscount = result.map((product: any) => {
      const retailPrice = parseFloat(product.product_price || 0);
      let wholesalePrice: number;
      if (product.retail_price) {
        wholesalePrice = parseFloat(product.retail_price || 0);
      } else {
        wholesalePrice = retailPrice; // No default discount - use retail price if wholesale price not set
      }

      const productSpecificDiscount = productDiscountsMap.get(product.product_id) || 0;
      const effectiveDiscount = productSpecificDiscount > 0 ? productSpecificDiscount : discountPercentage;

      const premiumDiscountPercentage = product.premium_discount_percentage ? parseFloat(product.premium_discount_percentage) : null;
      const productPricePremium = product.product_price_premium ? parseFloat(product.product_price_premium) : null;
      const premiumPriceDiscounted = product.premium_price_discounted ? parseFloat(product.premium_price_discounted) : null;

      const premiumFields = {
        premium_discount_percentage: premiumDiscountPercentage !== null ? premiumDiscountPercentage.toFixed(2) : '0.00',
        product_price_premium: productPricePremium !== null ? productPricePremium.toFixed(2) : '0.00',
        premium_price_discounted: premiumPriceDiscounted !== null ? premiumPriceDiscounted.toFixed(2) : '0.00',
      };

      // Map options
      let mappedOptions: any[] | null = null;
      if (product.options && Array.isArray(product.options)) {
        const optionsMap = new Map();
        for (const optVal of product.options) {
          if (!optionsMap.has(optVal.option_id)) {
            optionsMap.set(optVal.option_id, {
              option_id: optVal.option_id,
              option_name: optVal.option_name,
              option_type: optVal.option_type,
              required: optVal.required === 1,
              values: [],
            });
          }
          const option = optionsMap.get(optVal.option_id);
          const baseOptionPrice = parseFloat(optVal.product_option_price || 0);

          let finalOptionPrice = baseOptionPrice;
          if (isWholesaler) {
            const wholesaleOptionPrice = optVal.wholesale_price !== null ? parseFloat(optVal.wholesale_price) : null;
            if (wholesaleOptionPrice !== null && !isNaN(wholesaleOptionPrice)) {
              finalOptionPrice = wholesaleOptionPrice;
            }
          }

          option.values.push({
            ...optVal,
            product_option_price: finalOptionPrice,
            original_option_price: baseOptionPrice,
            discounted_option_price: finalOptionPrice,
            has_discount: finalOptionPrice < baseOptionPrice,
          });
        }
        mappedOptions = Array.from(optionsMap.values());
      }

      if (isRetailer) {
        if (effectiveDiscount > 0 && retailPrice > 0) {
          const discountAmount = retailPrice * (effectiveDiscount / 100);
          const finalPrice = retailPrice - discountAmount;
          return {
            ...product,
            product_price: finalPrice.toFixed(2),
            original_price: retailPrice,
            discounted_price: parseFloat(finalPrice.toFixed(2)),
            discount_percentage: effectiveDiscount,
            has_discount: true,
            ...premiumFields,
            options: mappedOptions,
          };
        } else {
          return {
            ...product,
            product_price: retailPrice.toFixed(2),
            original_price: retailPrice,
            discounted_price: retailPrice,
            discount_percentage: 0,
            has_discount: false,
            ...premiumFields,
            options: mappedOptions,
          };
        }
      } else if (isWholesaler) {
        if (effectiveDiscount > 0 && wholesalePrice > 0) {
          const discountAmount = wholesalePrice * (effectiveDiscount / 100);
          const finalPrice = wholesalePrice - discountAmount;
          return {
            ...product,
            product_price: finalPrice.toFixed(2),
            original_price: wholesalePrice,
            discounted_price: parseFloat(finalPrice.toFixed(2)),
            discount_percentage: effectiveDiscount,
            has_discount: true,
            ...premiumFields,
            options: mappedOptions,
          };
        } else {
          return {
            ...product,
            product_price: wholesalePrice.toFixed(2),
            original_price: wholesalePrice,
            discounted_price: wholesalePrice,
            discount_percentage: 0,
            has_discount: false,
            ...premiumFields,
            options: mappedOptions,
          };
        }
      } else {
        return {
          ...product,
          product_price: retailPrice.toFixed(2),
          original_price: retailPrice,
          discounted_price: retailPrice,
          discount_percentage: 0,
          has_discount: false,
          ...premiumFields,
          options: mappedOptions,
        };
      }
    });

    return { products: productsWithDiscount };
  }

  /**
   * Get reviews for a product
   */
  async getProductReviews(id: number, limit: number = 10, offset: number = 0) {
    const query = `
      SELECT 
        r.review_id,
        r.product_id,
        r.customer_id,
        r.rating,
        r.review_text,
        r.reviewer_name,
        r.created_at,
        c.firstname,
        c.lastname,
        c.email
      FROM product_review r
      LEFT JOIN customer c ON r.customer_id = c.customer_id
      WHERE r.product_id = $1 AND r.status = 1
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM product_review
      WHERE product_id = $1 AND status = 1
    `;

    const [reviewsResult, countResult] = await Promise.all([
      this.dataSource.query(query, [id, Number(limit), Number(offset)]),
      this.dataSource.query(countQuery, [id]),
    ]);

    const reviews = reviewsResult.map((review: any) => ({
      review_id: review.review_id,
      product_id: review.product_id,
      customer_id: review.customer_id,
      rating: review.rating,
      review_text: review.review_text,
      reviewer_name: review.reviewer_name ||
        (review.firstname && review.lastname ? `${review.firstname} ${review.lastname}` : 'Anonymous'),
      created_at: review.created_at,
    }));

    return {
      reviews,
      total: parseInt(countResult[0].total),
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  /**
   * Submit a product review
   */
  async submitProductReview(
    id: number,
    reviewData: {
      rating: number;
      review_text: string;
      reviewer_name?: string;
      reviewer_email?: string;
    },
    authHeader?: string,
  ) {
    const { rating, review_text, reviewer_name, reviewer_email } = reviewData;

    // Validation
    if (!rating || rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    if (!review_text || review_text.trim().length === 0) {
      throw new BadRequestException('Review text is required');
    }

    if (review_text.trim().length < 10) {
      throw new BadRequestException('Review text must be at least 10 characters');
    }

    // Get user from token if provided
    let userId: number | null = null;
    userId = this.extractUserIdFromToken(authHeader);

    // Get customer_id if user is logged in
    let customerId = null;
    if (userId) {
      const customerQuery = `SELECT customer_id FROM customer WHERE user_id = $1 LIMIT 1`;
      const customerResult = await this.dataSource.query(customerQuery, [userId]);
      if (customerResult.length > 0) {
        customerId = customerResult[0].customer_id;
      }
    }

    // Check if product exists
    const productQuery = `SELECT product_id FROM product WHERE product_id = $1 AND product_status = 1`;
    const productResult = await this.dataSource.query(productQuery, [id]);
    if (productResult.length === 0) {
      throw new NotFoundException('Product not found');
    }

    // Check if user already reviewed this product (if logged in)
    if (customerId) {
      const existingReviewQuery = `
        SELECT review_id FROM product_review 
        WHERE product_id = $1 AND customer_id = $2
      `;
      const existingReview = await this.dataSource.query(existingReviewQuery, [id, customerId]);
      if (existingReview.length > 0) {
        throw new BadRequestException('You have already reviewed this product');
      }
    }

    // Insert review
    const insertQuery = `
      INSERT INTO product_review (
        product_id,
        customer_id,
        user_id,
        rating,
        review_text,
        reviewer_name,
        reviewer_email,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING review_id, created_at
    `;

    const status = 0; // Pending approval - admin must review and publish

    const result = await this.dataSource.query(insertQuery, [
      id,
      customerId,
      userId || null,
      rating,
      review_text.trim(),
      reviewer_name || null,
      reviewer_email || null,
      status,
    ]);

    return {
      message: 'Review submitted successfully',
      review: {
        review_id: result[0].review_id,
        product_id: parseInt(id.toString()),
        rating,
        review_text: review_text.trim(),
        reviewer_name: reviewer_name || 'Anonymous',
        created_at: result[0].created_at,
      },
    };
  }
}
