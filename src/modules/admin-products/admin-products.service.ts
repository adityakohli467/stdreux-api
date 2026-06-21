import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FileStorageService } from '../../common/services/file-storage.service';
import { PricingService } from '../../common/services/pricing.service';

@Injectable()
export class AdminProductsService {
  private readonly logger = new Logger(AdminProductsService.name);

  constructor(
    private dataSource: DataSource,
    private fileStorageService: FileStorageService,
    private pricingService: PricingService,
  ) { }

  private async ensureProductColumnsExist(queryRunner: any) {
    // 1. Get all columns and their types
    const existing = await queryRunner.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'product'
    `);

    const columnMap = new Map(existing.map((r: any) => [r.column_name, r.data_type]));
    const toExecute: string[] = [];
    // 2. Define fields that MUST be 'text' to allow "any number of lines"
    const longTextFields = [
      'product_description',
      'short_description',
      'product_desc_1',
      'product_desc_2',
      'product_desc_3',
      'product_desc_4',
      'product_desc_5'
    ];
    for (const field of longTextFields) {
      if (!columnMap.has(field)) {
        // Create as text if it doesn't exist
        toExecute.push(`ALTER TABLE product ADD COLUMN ${field} text`);
      } else if (columnMap.get(field) === 'character varying') {
        // CONVERT existing varchar to text to fix the "too long" error
        this.logger.log(`Converting column ${field} from varchar to text...`);
        toExecute.push(`ALTER TABLE product ALTER COLUMN ${field} TYPE text`);
      }
    }
    // 3. Check for other missing columns (pricing, flags, etc.)
    const otherFields = [
      { name: 'user_price', sql: `ALTER TABLE product ADD COLUMN user_price decimal(10,2)` },
      { name: 'show_in_store', sql: `ALTER TABLE product ADD COLUMN show_in_store boolean DEFAULT true` },
      { name: 'add_to_subscription', sql: `ALTER TABLE product ADD COLUMN add_to_subscription boolean DEFAULT false` },
      { name: 'featured_1', sql: `ALTER TABLE product ADD COLUMN featured_1 boolean DEFAULT false` },
      { name: 'featured_2', sql: `ALTER TABLE product ADD COLUMN featured_2 boolean DEFAULT false` },
      { name: 'min_quantity', sql: `ALTER TABLE product ADD COLUMN min_quantity int DEFAULT 1` },
      { name: 'you_may_also_like', sql: `ALTER TABLE product ADD COLUMN you_may_also_like boolean DEFAULT false` },
      { name: 'show_in_checkout', sql: `ALTER TABLE product ADD COLUMN show_in_checkout boolean DEFAULT false` },
      { name: 'roast_level', sql: `ALTER TABLE product ADD COLUMN roast_level varchar(255)` },
      { name: 'show_specifications', sql: `ALTER TABLE product ADD COLUMN show_specifications boolean DEFAULT false` },
      { name: 'show_other_info', sql: `ALTER TABLE product ADD COLUMN show_other_info boolean DEFAULT false` },
      { name: 'premium_discount_percentage', sql: `ALTER TABLE product ADD COLUMN premium_discount_percentage decimal(5,2)` },
      { name: 'product_price_premium', sql: `ALTER TABLE product ADD COLUMN product_price_premium decimal(10,2)` },
      { name: 'premium_price_discounted', sql: `ALTER TABLE product ADD COLUMN premium_price_discounted decimal(10,2)` },
      { name: 'subscriber_rate', sql: `ALTER TABLE product ADD COLUMN subscriber_rate decimal(10,2)` }
    ];
    for (const field of otherFields) {
      if (!columnMap.has(field.name)) {
        toExecute.push(field.sql);
      }
    }
    // 4. Run the fixes
    for (const sql of toExecute) {
      try {
        await queryRunner.query(sql);
      } catch (err) {
        this.logger.error(`Failed to apply DB fix: ${sql}`, err);
      }
    }
  }

  /**
   * List products with search and pagination
   * @param filters - Filter options including optional customer_id for price calculation
   */
  async listProducts(filters: {
    limit?: number;
    offset?: number;
    search?: string;
    status?: number;
    customer_id?: number; // Optional: if provided, prices will be calculated based on customer type and discounts
    company_id?: number; // Optional: if provided, company-level pricing overrides customer pricing
  }) {
    const { limit = 20, offset = 0, search, status } = filters;

    // Check if subscriber_price column exists on option_value
    const subPriceCheck = await this.dataSource.query(`
      SELECT 1 FROM information_schema.columns 
      WHERE table_name = 'option_value' AND column_name = 'subscriber_price'
    `);
    const hasSubscriberPrice = subPriceCheck.length > 0;

    let query = `
      SELECT 
        p.*,
        (
          SELECT json_agg(json_build_object('category_id', c.category_id, 'category_name', c.category_name, 'gst_free', COALESCE(c.gst_free, false)))
          FROM product_category pc
          JOIN category c ON pc.category_id = c.category_id
          WHERE pc.product_id = p.product_id
        ) as categories,
        (
          SELECT json_agg(
            json_build_object(
              'product_option_id', po.product_option_id,
              'option_id', o.option_id,
              'option_name', o.name,
              'option_type', o.option_type,
              'option_value_id', ov.option_value_id,
              'option_value_name', ov.name,
              'option_price', po.option_price,
              'option_price_prefix', po.option_price_prefix,
              'option_required', po.option_required,
              'standard_price', ov.standard_price,
              'wholesale_price', ov.wholesale_price,
              'wholesale_price_premium', ov.wholesale_price_premium
              ${hasSubscriberPrice ? ", 'subscriber_price', ov.subscriber_price" : ""}
            )
          )
          FROM product_option po
          JOIN option_value ov ON po.option_value_id = ov.option_value_id
          JOIN options o ON ov.option_id = o.option_id
          WHERE po.product_id = p.product_id
        ) as options,
        (
          SELECT json_build_object('category_id', sc.category_id, 'category_name', sc.category_name)
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
        ) as product_images
      FROM product p
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    // Search filter
    if (search) {
      query += ` AND (p.product_name ILIKE $${paramIndex} OR p.product_description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Status filter
    if (status !== undefined) {
      query += ` AND p.product_status = $${paramIndex}`;
      params.push(Number(status));
      paramIndex++;
    }

    query += ' ORDER BY p.product_id DESC';
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await this.dataSource.query(query, params);

    // Get customer type and discounts if customer_id provided
    let customerType: string | null = null;
    let isWholesale = false;
    const productDiscountsMap = new Map<number, number>();
    const optionDiscountsMap = new Map<string, number>();
    const companyProductDiscountsMap = new Map<number, number>();
    const companyOptionDiscountsMap = new Map<string, number>();

    if (filters.customer_id) {
      try {
        // Get customer type
        const customerQuery = `SELECT customer_type FROM customer WHERE customer_id = $1`;
        const customerResult = await this.dataSource.query(customerQuery, [filters.customer_id]);
        if (customerResult.length > 0) {
          customerType = customerResult[0].customer_type || null;
          isWholesale = customerType?.includes('Wholesale') || customerType?.includes('Wholesaler') || false;
        }

        // Get product-level discounts
        const productDiscountQuery = `
          SELECT product_id, discount_percentage
          FROM customer_product_discount
          WHERE customer_id = $1
        `;
        const productDiscountResult = await this.dataSource.query(productDiscountQuery, [filters.customer_id]);
        productDiscountResult.forEach((row: any) => {
          productDiscountsMap.set(row.product_id, parseFloat(row.discount_percentage || 0));
        });

        // Get option-level discounts
        const optionDiscountQuery = `
          SELECT product_id, option_value_id, discount_percentage
          FROM customer_product_option_discount
          WHERE customer_id = $1
        `;
        const optionDiscountResult = await this.dataSource.query(optionDiscountQuery, [filters.customer_id]);
        optionDiscountResult.forEach((row: any) => {
          const key = `${row.product_id}_${row.option_value_id}`;
          optionDiscountsMap.set(key, parseFloat(row.discount_percentage || 0));
        });
      } catch (error) {
        this.logger.error('Error fetching customer discounts:', error);
      }
    }

    // Resolve effective company_id (explicit company_id wins, else customer's company)
    let effectiveCompanyId: number | null = filters.company_id || null;
    if (!effectiveCompanyId && filters.customer_id) {
      effectiveCompanyId = await this.pricingService.getCompanyIdForCustomer(filters.customer_id);
    }
    if (effectiveCompanyId) {
      const companyDiscounts = await this.pricingService.getCompanyDiscounts(effectiveCompanyId);
      companyDiscounts.productDiscounts.forEach((value, key) => companyProductDiscountsMap.set(key, value));
      companyDiscounts.optionDiscounts.forEach((value, key) => companyOptionDiscountsMap.set(key, value));
    }

    // Apply pricing based on customer type and discounts using pricing service
    const productsWithPricing = result.map((product: any) => {
      const retailPrice = parseFloat(product.product_price || 0);
      const wholesalePrice = product.retail_price ? parseFloat(product.retail_price || 0) : null;
      const retailDiscountPercentage = product.retail_discount_percentage ? parseFloat(product.retail_discount_percentage) : null;
      const productDiscount = productDiscountsMap.get(product.product_id) || 0;
      const companyProductDiscount = companyProductDiscountsMap.get(product.product_id) || 0;

      // Use pricing service for consistent calculations
      const pricing = this.pricingService.calculateProductPrice(
        retailPrice,
        wholesalePrice,
        retailDiscountPercentage,
        isWholesale,
        productDiscount,
        null,
        companyProductDiscount,
      );

      // Process options with pricing using pricing service
      let optionsWithPricing = null;
      if (product.options && Array.isArray(product.options)) {
        optionsWithPricing = product.options.map((option: any) => {
          const baseOptionPrice = parseFloat(option.option_price || 0);
          const standardPrice = option.standard_price ? parseFloat(option.standard_price) : null;
          const optionWholesalePrice = option.wholesale_price ? parseFloat(option.wholesale_price) : null;
          const optionKey = `${product.product_id}_${option.option_value_id}`;
          const optionDiscount = optionDiscountsMap.get(optionKey) || 0;
          const companyOptionDiscount = companyOptionDiscountsMap.get(optionKey) || 0;

          const optionPricing = this.pricingService.calculateOptionPrice(
            standardPrice,
            optionWholesalePrice,
            baseOptionPrice,
            isWholesale,
            optionDiscount,
            companyOptionDiscount,
          );

          return {
            ...option,
            option_base_price: optionPricing.basePrice,
            option_price: optionPricing.finalPrice,
            discount_percentage: optionPricing.discountPercentage,
            original_option_price: optionPricing.basePrice,
            has_discount: optionPricing.hasDiscount,
          };
        });
      }

      return {
        ...product,
        product_price: pricing.finalPrice,
        original_price: pricing.basePrice,
        base_retail_price: pricing.originalPrice,
        base_wholesale_price: pricing.wholesalePrice,
        discount_percentage: pricing.discountPercentage,
        has_discount: pricing.hasDiscount,
        customer_type: customerType,
        is_wholesale: pricing.isWholesale,
        options: optionsWithPricing || product.options,
      };
    });

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM product p WHERE 1=1';
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (search) {
      countQuery += ` AND (p.product_name ILIKE $${countParamIndex} OR p.product_description ILIKE $${countParamIndex})`;
      countParams.push(`%${search}%`);
      countParamIndex++;
    }

    if (status !== undefined) {
      countQuery += ` AND p.product_status = $${countParamIndex}`;
      countParams.push(Number(status));
    }

    const countResult = await this.dataSource.query(countQuery, countParams);
    const count = parseInt(countResult[0].count);

    return {
      products: productsWithPricing,
      count,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  async getProduct(id: number, customer_id?: number, company_id?: number) {
    // Check if subscriber_price column exists on option_value
    const subPriceCheck = await this.dataSource.query(`
      SELECT 1 FROM information_schema.columns 
      WHERE table_name = 'option_value' AND column_name = 'subscriber_price'
    `);
    const hasSubscriberPrice = subPriceCheck.length > 0;

    const query = `
      SELECT 
        p.*,
        (
          SELECT json_agg(json_build_object('category_id', c.category_id, 'category_name', c.category_name, 'gst_free', COALESCE(c.gst_free, false)))
          FROM product_category pc
          JOIN category c ON pc.category_id = c.category_id
          WHERE pc.product_id = p.product_id
        ) as categories,
        (
          SELECT json_agg(
            json_build_object(
              'product_option_id', po.product_option_id,
              'option_id', o.option_id,
              'option_name', o.name,
              'option_type', o.option_type,
              'option_value_id', ov.option_value_id,
              'option_value_name', ov.name,
              'option_price', po.option_price,
              'option_price_prefix', po.option_price_prefix,
              'option_required', po.option_required,
              'standard_price', ov.standard_price,
              'wholesale_price', ov.wholesale_price,
              'wholesale_price_premium', ov.wholesale_price_premium,
              ${hasSubscriberPrice ? "'subscriber_price', ov.subscriber_price," : ""}
              'discount_percentage', 0
            )
          )
          FROM product_option po
          JOIN option_value ov ON po.option_value_id = ov.option_value_id
          JOIN options o ON ov.option_id = o.option_id
          WHERE po.product_id = p.product_id
        ) as options,
        (
          SELECT json_build_object('category_id', sc.category_id, 'category_name', sc.category_name)
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
        ) as product_images
      FROM product p
      WHERE p.product_id = $1
    `;

    const result = await this.dataSource.query(query, [Number(id)]);

    if (result.length === 0) {
      throw new NotFoundException('Product not found');
    }

    const product = result[0];

    // Get customer type and discounts if customer_id provided
    let customerType: string | null = null;
    let isWholesale = false;
    const productDiscountsMap = new Map<number, number>();
    const optionDiscountsMap = new Map<string, number>();
    const companyOptionDiscountsMap = new Map<string, number>();
    let companyProductDiscount = 0;

    if (customer_id) {
      try {
        // Get customer type
        const customerQuery = `SELECT customer_type FROM customer WHERE customer_id = $1`;
        const customerResult = await this.dataSource.query(customerQuery, [customer_id]);
        if (customerResult.length > 0) {
          customerType = customerResult[0].customer_type || null;
          isWholesale = customerType?.includes('Wholesale') || customerType?.includes('Wholesaler') || false;
        }

        // Get product-level discount
        const productDiscountQuery = `
          SELECT discount_percentage
          FROM customer_product_discount
          WHERE customer_id = $1 AND product_id = $2
        `;
        const productDiscountResult = await this.dataSource.query(productDiscountQuery, [customer_id, id]);
        if (productDiscountResult.length > 0) {
          productDiscountsMap.set(id, parseFloat(productDiscountResult[0].discount_percentage || 0));
        }

        // Get option-level discounts
        const optionDiscountQuery = `
          SELECT option_value_id, discount_percentage
          FROM customer_product_option_discount
          WHERE customer_id = $1 AND product_id = $2
        `;
        const optionDiscountResult = await this.dataSource.query(optionDiscountQuery, [customer_id, id]);
        optionDiscountResult.forEach((row: any) => {
          const key = `${id}_${row.option_value_id}`;
          optionDiscountsMap.set(key, parseFloat(row.discount_percentage || 0));
        });
      } catch (error) {
        this.logger.error('Error fetching customer discounts:', error);
      }
    }

    // Resolve effective company_id (explicit company_id wins, else customer's company)
    let effectiveCompanyId: number | null = company_id || null;
    if (!effectiveCompanyId && customer_id) {
      effectiveCompanyId = await this.pricingService.getCompanyIdForCustomer(customer_id);
    }
    if (effectiveCompanyId) {
      const companyDiscounts = await this.pricingService.getCompanyDiscounts(effectiveCompanyId);
      companyProductDiscount = companyDiscounts.productDiscounts.get(Number(id)) || 0;
      companyDiscounts.optionDiscounts.forEach((value, key) => {
        const [pid] = key.split('_').map((v) => parseInt(v));
        if (pid === Number(id)) {
          companyOptionDiscountsMap.set(key, value);
        }
      });
    }

    // Apply pricing based on customer type and discounts
    const retailPrice = parseFloat(product.product_price || 0);
    const wholesalePrice = product.retail_price ? parseFloat(product.retail_price || 0) : null;
    const retailDiscountPercentage = product.retail_discount_percentage ? parseFloat(product.retail_discount_percentage) : null;
    const productDiscount = productDiscountsMap.get(id) || 0;

    // Use pricing service for consistent calculations
    const pricing = this.pricingService.calculateProductPrice(
      retailPrice,
      wholesalePrice,
      retailDiscountPercentage,
      isWholesale,
      productDiscount,
      null,
      companyProductDiscount,
    );

    // Process options with pricing using pricing service
    let optionsWithPricing = null;
    if (product.options && Array.isArray(product.options)) {
      optionsWithPricing = product.options.map((option: any) => {
        const baseOptionPrice = parseFloat(option.option_price || 0);
        const standardPrice = option.standard_price ? parseFloat(option.standard_price) : null;
        const optionWholesalePrice = option.wholesale_price ? parseFloat(option.wholesale_price) : null;
        const optionKey = `${id}_${option.option_value_id}`;
        const optionDiscount = optionDiscountsMap.get(optionKey) || 0;
        const companyOptionDiscount = companyOptionDiscountsMap.get(optionKey) || 0;

        const optionPricing = this.pricingService.calculateOptionPrice(
          standardPrice,
          optionWholesalePrice,
          baseOptionPrice,
          isWholesale,
          optionDiscount,
          companyOptionDiscount,
        );

        return {
          ...option,
          option_base_price: optionPricing.basePrice,
          option_price: optionPricing.finalPrice,
          discount_percentage: optionPricing.discountPercentage,
          original_option_price: optionPricing.basePrice,
          has_discount: optionPricing.hasDiscount,
        };
      });
    }

    return {
      product: {
        ...product,
        product_price: pricing.finalPrice,
        original_price: pricing.basePrice,
        base_retail_price: pricing.originalPrice,
        base_wholesale_price: pricing.wholesalePrice,
        discount_percentage: pricing.discountPercentage,
        has_discount: pricing.hasDiscount,
        customer_type: customerType,
        is_wholesale: pricing.isWholesale,
        options: optionsWithPricing || product.options,
      },
    };
  }

  /**
   * Create product
   */
  async createProduct(
    productData: {
      product_name: string;
      product_description?: string;
      short_description?: string;
      roast_level?: string;
      show_specifications?: boolean;
      show_other_info?: boolean;
      product_price: number;
      retail_price?: number;
      user_price?: number;
      retail_discount_percentage?: number;
      customer_type_visibility?: string;
      product_status?: number;
      user_id: number;
      categories?: number[];
      subcategory_id?: number;
      options?: any[];
      product_image_url?: string;
      product_images?: string[];
      min_quantity?: number;
      you_may_also_like?: boolean;
      show_in_checkout?: boolean;
      show_in_store?: boolean;
      add_to_subscription?: boolean;
      featured_1?: boolean;
      featured_2?: boolean;
      premium_discount_percentage?: number;
      product_price_premium?: number;
      premium_price_discounted?: number;
      subscriber_rate?: number;
      product_desc_1?: string;
      product_desc_2?: string;
      product_desc_3?: string;
      product_desc_4?: string;
      product_desc_5?: string;
    },
    files?: Express.Multer.File[],
  ) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.ensureProductColumnsExist(queryRunner);
      const uploadedImageUrls: string[] = [];

      // Handle image uploads
      if (files && Array.isArray(files) && files.length > 0) {
        this.logger.log(`Starting upload of ${files.length} image(s)...`);
        for (const file of files) {
          try {
            const tempProductId = Date.now();
            const result = await this.fileStorageService.uploadProductImage(
              file.buffer,
              tempProductId,
              file.originalname,
            );
            this.logger.log(`✅ Successfully uploaded ${file.originalname}: ${result.url}`);
            uploadedImageUrls.push(result.url);
          } catch (error: any) {
            this.logger.error(`❌ Failed to upload ${file.originalname}:`, error);
            throw new Error(`Failed to upload image ${file.originalname}: ${error.message || error}`);
          }
        }
      }

      // Combine uploaded images with any existing image URLs
      // Normalize existing images to strings if they are objects
      const existingImages = (productData.product_images || []).map((img: any) =>
        typeof img === 'object' && img !== null ? img.image_url : img
      ).filter((img: any) => typeof img === 'string' && img.trim() !== '');

      const allImageUrls = [...uploadedImageUrls, ...existingImages];

      const {
        product_name,
        product_description,
        short_description,
        roast_level,
        show_specifications,
        show_other_info,
        product_price,
        retail_price,
        user_price,
        retail_discount_percentage,
        customer_type_visibility,
        product_status,
        user_id,
        categories,
        subcategory_id,
        options,
        product_image_url,
        min_quantity,
        you_may_also_like,
        show_in_checkout,
        show_in_store,
        add_to_subscription,
        featured_1,
        featured_2,
        premium_discount_percentage,
        product_price_premium,
        premium_price_discounted,
        subscriber_rate,
        product_desc_1,
        product_desc_2,
        product_desc_3,
        product_desc_4,
        product_desc_5,
      } = productData;

      // Validation
      if (!product_name || product_name.trim() === '') {
        throw new BadRequestException('Product name is required');
      }

      if (product_name.length > 255) {
        throw new BadRequestException('Product name must be 255 characters or less');
      }

      if (product_price === undefined || product_price === null) {
        throw new BadRequestException('Product price is required');
      }

      const price = parseFloat(product_price.toString());
      if (isNaN(price) || price < 0 || price > 99999999.99) {
        throw new BadRequestException('Product price must be a valid number between 0 and 99,999,999.99');
      }

      if (product_description && product_description.length > 10000) {
        throw new BadRequestException('Product description must be 10,000 characters or less');
      }

      if (!user_id) {
        throw new BadRequestException('User ID is required');
      }

      if (product_image_url && product_image_url.length > 500) {
        throw new BadRequestException('Product image URL must be 500 characters or less');
      }

      if (allImageUrls.length > 10) {
        throw new BadRequestException('Maximum 10 images allowed per product');
      }

      // Calculate retail_price if not provided
      let finalRetailPrice = retail_price;
      if (!finalRetailPrice && product_price && retail_discount_percentage) {
        const priceNum = parseFloat(product_price.toString());
        const discountNum = parseFloat(retail_discount_percentage.toString());
        if (!isNaN(priceNum) && !isNaN(discountNum)) {
          finalRetailPrice = priceNum * (1 - discountNum / 100);
        }
      }

      // Set default visibility if not provided
      const visibility = customer_type_visibility || 'all';

      // Create product (conditionally include columns that may not exist)
      const colCheckResult = await queryRunner.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'product' 
          AND column_name IN ('user_price', 'subscriber_rate')
      `);
      const existingProdCols = colCheckResult.map((r: any) => r.column_name);
      const hasUserPrice = existingProdCols.includes('user_price');
      const hasSubscriberRate = existingProdCols.includes('subscriber_rate');

      const columns: string[] = [
        'product_name',
        'product_description',
        'short_description',
        'roast_level',
        'show_specifications',
        'show_other_info',
        'product_price',
        'retail_price',
        'retail_discount_percentage',
        'customer_type_visibility',
        'product_status',
        'user_id',
        'product_image',
        'subcategory_id',
        'min_quantity',
        'you_may_also_like',
        'show_in_checkout',
        'show_in_store',
        'add_to_subscription',
        'featured_1',
        'featured_2',
        'premium_discount_percentage',
        'product_price_premium',
        'premium_price_discounted',
        'product_desc_1',
        'product_desc_2',
        'product_desc_3',
        'product_desc_4',
        'product_desc_5',
      ];
      const values: any[] = [
        product_name,
        product_description || '',
        short_description || null,
        roast_level || null,
        show_specifications || false,
        show_other_info || false,
        product_price,
        finalRetailPrice ? parseFloat(finalRetailPrice.toString()).toFixed(2) : null,
        retail_discount_percentage || null,
        visibility,
        product_status || 1,
        user_id,
        product_image_url || null,
        subcategory_id || null,
        min_quantity || 1,
        you_may_also_like || false,
        show_in_checkout || false,
        show_in_store || false,
        add_to_subscription || false,
        featured_1 || false,
        featured_2 || false,
        premium_discount_percentage !== undefined ? premium_discount_percentage : null,
        product_price_premium !== undefined ? product_price_premium : null,
        premium_price_discounted !== undefined ? premium_price_discounted : null,
        product_desc_1 || null,
        product_desc_2 || null,
        product_desc_3 || null,
        product_desc_4 || null,
        product_desc_5 || null,
      ];

      if (hasSubscriberRate) {
        columns.push('subscriber_rate');
        values.push(subscriber_rate !== undefined ? subscriber_rate : null);
      }

      if (hasUserPrice) {
        columns.push('user_price');
        values.push(
          user_price !== undefined && user_price !== null
            ? parseFloat(user_price.toString()).toFixed(2)
            : null,
        );
      }

      // Append date columns
      columns.push('product_date_added', 'product_date_modified');

      const placeholders = values.map((_, idx) => `$${idx + 1}`).join(', ');
      const insertQuery = `
        INSERT INTO product (${columns.join(', ')})
        VALUES (${placeholders}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *
      `;

      const productResult = await queryRunner.query(insertQuery, values);

      const newProduct = productResult[0];

      // Insert categories if provided
      if (categories && Array.isArray(categories) && categories.length > 0) {
        for (let categoryId of categories) {
          // Extract ID if object was passed
          if (typeof categoryId === 'object' && categoryId !== null && 'category_id' in categoryId) {
            categoryId = (categoryId as any).category_id;
          }

          if (categoryId) {
            await queryRunner.query(
              'INSERT INTO product_category (product_id, category_id) VALUES ($1, $2)',
              [newProduct.product_id, categoryId],
            );
          }
        }
      }

      // Insert options if provided
      if (options && Array.isArray(options) && options.length > 0) {
        for (const option of options) {
          if (!option.option_value_id) {
            throw new BadRequestException(`Missing option_value_id in option: ${JSON.stringify(option)}`);
          }
          await queryRunner.query(
            `INSERT INTO product_option (product_id, option_value_id, option_price, option_price_prefix, option_required) 
             VALUES ($1, $2, $3, $4, $5)`,
            [
              newProduct.product_id,
              option.option_value_id,
              option.option_price || 0,
              option.option_price_prefix || '+',
              option.option_required || 0,
            ],
          );
        }
      }

      // Insert product images if provided
      if (allImageUrls && Array.isArray(allImageUrls) && allImageUrls.length > 0) {
        this.logger.log(`Inserting ${allImageUrls.length} images for product ${newProduct.product_id}`);
        for (let i = 0; i < allImageUrls.length; i++) {
          const imageUrl = allImageUrls[i];
          if (imageUrl && typeof imageUrl === 'string' && imageUrl.trim() !== '') {
            try {
              await queryRunner.query(
                `INSERT INTO product_images (product_id, image_url, image_order) 
                 VALUES ($1, $2, $3)`,
                [newProduct.product_id, imageUrl.trim(), i],
              );
              this.logger.log(`Inserted image ${i + 1}: ${imageUrl}`);
            } catch (imgError) {
              this.logger.error(`Failed to insert image ${i + 1}:`, imgError);
              // Continue with other images even if one fails
            }
          }
        }
      }

      await queryRunner.commitTransaction();

      // Fetch the complete product
      const completeProduct = await this.getProduct(newProduct.product_id);

      return {
        product: completeProduct.product,
        message: 'Product created successfully',
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Update product
   */
  async updateProduct(
    id: number,
    productData: {
      product_name?: string;
      product_description?: string;
      short_description?: string;
      roast_level?: string;
      show_specifications?: boolean;
      show_other_info?: boolean;
      product_price?: number;
      retail_price?: number;
      user_price?: number;
      retail_discount_percentage?: number;
      customer_type_visibility?: string;
      product_status?: number;
      categories?: number[];
      subcategory_id?: number;
      options?: any[];
      product_image_url?: string;
      product_images?: string[];
      min_quantity?: number;
      you_may_also_like?: boolean;
      show_in_checkout?: boolean;
      show_in_store?: boolean;
      add_to_subscription?: boolean;
      featured_1?: boolean;
      featured_2?: boolean;
      premium_discount_percentage?: number;
      product_price_premium?: number;
      premium_price_discounted?: number;
      subscriber_rate?: number;
      product_desc_1?: string;
      product_desc_2?: string;
      product_desc_3?: string;
      product_desc_4?: string;
      product_desc_5?: string;
    },
    files?: Express.Multer.File[],
  ) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.ensureProductColumnsExist(queryRunner);
      const uploadedImageUrls: string[] = [];

      // Handle image uploads
      if (files && Array.isArray(files) && files.length > 0) {
        this.logger.log(`Starting upload of ${files.length} image(s) for product update...`);
        for (const file of files) {
          try {
            const result = await this.fileStorageService.uploadProductImage(
              file.buffer,
              Number(id),
              file.originalname,
            );
            this.logger.log(`✅ Successfully uploaded ${file.originalname}: ${result.url}`);
            uploadedImageUrls.push(result.url);
          } catch (error: any) {
            this.logger.error(`❌ Failed to upload ${file.originalname}:`, error);
            // Don't fail the entire update - continue with other images
          }
        }
      }

      // Combine uploaded images with any existing image URLs
      // Normalize existing images to strings if they are objects
      const existingImages = (productData.product_images || []).map((img: any) =>
        typeof img === 'object' && img !== null ? img.image_url : img
      ).filter((img: any) => typeof img === 'string' && img.trim() !== '');

      const allImageUrls = [...uploadedImageUrls, ...existingImages];

      const {
        product_name,
        product_description,
        short_description,
        roast_level,
        show_specifications,
        show_other_info,
        product_price,
        retail_price,
        user_price,
        retail_discount_percentage,
        customer_type_visibility,
        product_status,
        categories,
        subcategory_id,
        options,
        product_image_url,
        min_quantity,
        you_may_also_like,
        show_in_checkout,
        show_in_store,
        add_to_subscription,
        featured_1,
        featured_2,
        premium_discount_percentage,
        product_price_premium,
        premium_price_discounted,
        subscriber_rate,
        product_desc_1,
        product_desc_2,
        product_desc_3,
        product_desc_4,
        product_desc_5,
      } = productData;

      // Validate update fields
      if (product_name !== undefined && product_name !== null) {
        if (product_name.trim() === '') {
          throw new BadRequestException('Product name cannot be empty');
        }
        if (product_name.length > 255) {
          throw new BadRequestException('Product name must be 255 characters or less');
        }
      }

      if (product_price !== undefined && product_price !== null) {
        const price = parseFloat(product_price.toString());
        if (isNaN(price) || price < 0 || price > 99999999.99) {
          throw new BadRequestException('Product price must be a valid number between 0 and 99,999,999.99');
        }
      }

      if (product_description !== undefined && product_description !== null && product_description.length > 10000) {
        throw new BadRequestException('Product description must be 10,000 characters or less');
      }

      if (product_image_url && product_image_url.length > 500) {
        throw new BadRequestException('Product image URL must be 500 characters or less');
      }

      // Calculate retail_price if not provided but product_price is being updated
      let finalRetailPrice = retail_price;
      if (!finalRetailPrice && product_price && retail_discount_percentage) {
        const priceNum = parseFloat(product_price.toString());
        const discountNum = parseFloat(retail_discount_percentage.toString());
        if (!isNaN(priceNum) && !isNaN(discountNum)) {
          finalRetailPrice = priceNum * (1 - discountNum / 100);
        }
      }

      // Build dynamic UPDATE query for new fields
      const updateFields: string[] = [];
      const updateParams: any[] = [];
      let paramIndex = 1;

      if (product_name !== undefined) {
        updateFields.push(`product_name = $${paramIndex++}`);
        updateParams.push(product_name);
      }
      if (product_description !== undefined) {
        updateFields.push(`product_description = $${paramIndex++}`);
        updateParams.push(product_description);
      }
      if (short_description !== undefined) {
        updateFields.push(`short_description = $${paramIndex++}`);
        updateParams.push(short_description || null);
      }
      if (roast_level !== undefined) {
        updateFields.push(`roast_level = $${paramIndex++}`);
        updateParams.push(roast_level || null);
      }
      if (show_specifications !== undefined) {
        updateFields.push(`show_specifications = $${paramIndex++}`);
        updateParams.push(show_specifications);
      }
      if (show_other_info !== undefined) {
        updateFields.push(`show_other_info = $${paramIndex++}`);
        updateParams.push(show_other_info);
      }
      if (product_price !== undefined) {
        updateFields.push(`product_price = $${paramIndex++}`);
        updateParams.push(product_price);
      }
      if (finalRetailPrice !== undefined) {
        updateFields.push(`retail_price = $${paramIndex++}`);
        updateParams.push(finalRetailPrice ? parseFloat(finalRetailPrice.toString()).toFixed(2) : null);
      }
      if (user_price !== undefined) {
        updateFields.push(`user_price = $${paramIndex++}`);
        updateParams.push(user_price !== null ? parseFloat(user_price.toString()).toFixed(2) : null);
      }
      if (retail_discount_percentage !== undefined) {
        updateFields.push(`retail_discount_percentage = $${paramIndex++}`);
        updateParams.push(retail_discount_percentage);
      }
      if (customer_type_visibility !== undefined) {
        updateFields.push(`customer_type_visibility = $${paramIndex++}`);
        updateParams.push(customer_type_visibility);
      }
      if (product_status !== undefined) {
        updateFields.push(`product_status = $${paramIndex++}`);
        updateParams.push(product_status);
      }
      if (product_image_url !== undefined) {
        updateFields.push(`product_image = $${paramIndex++}`);
        updateParams.push(product_image_url);
      }
      if (subcategory_id !== undefined) {
        updateFields.push(`subcategory_id = $${paramIndex++}`);
        updateParams.push(subcategory_id || null);
      }
      if (min_quantity !== undefined) {
        updateFields.push(`min_quantity = $${paramIndex++}`);
        updateParams.push(min_quantity);
      }
      if (you_may_also_like !== undefined) {
        updateFields.push(`you_may_also_like = $${paramIndex++}`);
        updateParams.push(you_may_also_like);
      }
      if (show_in_checkout !== undefined) {
        updateFields.push(`show_in_checkout = $${paramIndex++}`);
        updateParams.push(show_in_checkout);
      }
      if (show_in_store !== undefined) {
        updateFields.push(`show_in_store = $${paramIndex++}`);
        updateParams.push(show_in_store);
      }
      if (add_to_subscription !== undefined) {
        updateFields.push(`add_to_subscription = $${paramIndex++}`);
        updateParams.push(add_to_subscription);
      }
      if (featured_1 !== undefined) {
        updateFields.push(`featured_1 = $${paramIndex++}`);
        updateParams.push(featured_1);
      }
      if (featured_2 !== undefined) {
        updateFields.push(`featured_2 = $${paramIndex++}`);
        updateParams.push(featured_2);
      }
      if (premium_discount_percentage !== undefined) {
        updateFields.push(`premium_discount_percentage = $${paramIndex++}`);
        updateParams.push(premium_discount_percentage);
      }
      if (product_price_premium !== undefined) {
        updateFields.push(`product_price_premium = $${paramIndex++}`);
        updateParams.push(product_price_premium);
      }
      if (premium_price_discounted !== undefined) {
        updateFields.push(`premium_price_discounted = $${paramIndex++}`);
        updateParams.push(premium_price_discounted);
      }
      if (subscriber_rate !== undefined) {
        // Check if subscriber_rate column exists before trying to update it
        const subRateCheck = await queryRunner.query(`
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'product' AND column_name = 'subscriber_rate'
        `);
        if (subRateCheck.length > 0) {
          updateFields.push(`subscriber_rate = $${paramIndex++}`);
          updateParams.push(subscriber_rate);
        }
      }
      if (product_desc_1 !== undefined) {
        updateFields.push(`product_desc_1 = $${paramIndex++}`);
        updateParams.push(product_desc_1 || null);
      }
      if (product_desc_2 !== undefined) {
        updateFields.push(`product_desc_2 = $${paramIndex++}`);
        updateParams.push(product_desc_2 || null);
      }
      if (product_desc_3 !== undefined) {
        updateFields.push(`product_desc_3 = $${paramIndex++}`);
        updateParams.push(product_desc_3 || null);
      }
      if (product_desc_4 !== undefined) {
        updateFields.push(`product_desc_4 = $${paramIndex++}`);
        updateParams.push(product_desc_4 || null);
      }
      if (product_desc_5 !== undefined) {
        updateFields.push(`product_desc_5 = $${paramIndex++}`);
        updateParams.push(product_desc_5 || null);
      }

      updateFields.push('product_date_modified = CURRENT_TIMESTAMP');
      updateParams.push(Number(id));

      const updateQuery = `UPDATE product 
         SET ${updateFields.join(', ')}
         WHERE product_id = $${paramIndex}
         RETURNING *`;

      const result = await queryRunner.query(updateQuery, updateParams);

      if (result.length === 0) {
        throw new NotFoundException('Product not found');
      }

      // Update categories if provided
      if (categories !== undefined && Array.isArray(categories)) {
        // Delete existing categories
        await queryRunner.query('DELETE FROM product_category WHERE product_id = $1', [Number(id)]);

        // Insert new categories
        for (let categoryId of categories) {
          // Extract ID if object was passed
          if (typeof categoryId === 'object' && categoryId !== null && 'category_id' in categoryId) {
            categoryId = (categoryId as any).category_id;
          }

          if (categoryId) {
            await queryRunner.query(
              'INSERT INTO product_category (product_id, category_id) VALUES ($1, $2)',
              [Number(id), categoryId],
            );
          }
        }
      }

      // Update options if provided
      if (options !== undefined && Array.isArray(options)) {
        // Delete existing options
        await queryRunner.query('DELETE FROM product_option WHERE product_id = $1', [Number(id)]);

        // Insert new options
        for (const option of options) {
          if (!option.option_value_id) {
            throw new BadRequestException(`Missing option_value_id in option: ${JSON.stringify(option)}`);
          }
          await queryRunner.query(
            `INSERT INTO product_option (product_id, option_value_id, option_price, option_price_prefix, option_required) 
             VALUES ($1, $2, $3, $4, $5)`,
            [
              Number(id),
              option.option_value_id,
              option.option_price || 0,
              option.option_price_prefix || '+',
              option.option_required || 0,
            ],
          );
        }
      }

      // Update product images ONLY if they were provided in the request
      // This prevents accidental deletion of all images if the caller didn't include images
      const shouldUpdateImages = (files && files.length > 0) || (productData.product_images !== undefined);

      if (shouldUpdateImages) {
        // Delete existing images
        await queryRunner.query('DELETE FROM product_images WHERE product_id = $1', [Number(id)]);

        // Insert new images (including newly uploaded ones)
        if (Array.isArray(allImageUrls) && allImageUrls.length > 0) {
          this.logger.log(`Updating ${allImageUrls.length} images for product ${id}`);
          for (let i = 0; i < allImageUrls.length; i++) {
            let imageUrl = allImageUrls[i];

            // Extract URL if object was passed
            if (typeof imageUrl === 'object' && imageUrl !== null && 'image_url' in imageUrl) {
              imageUrl = (imageUrl as any).image_url;
            }

            if (imageUrl && typeof imageUrl === 'string' && imageUrl.trim() !== '') {
              try {
                await queryRunner.query(
                  `INSERT INTO product_images (product_id, image_url, image_order) 
                   VALUES ($1, $2, $3)`,
                  [Number(id), (imageUrl as string).trim(), i],
                );
                this.logger.log(`Inserted image ${i + 1}: ${imageUrl}`);
              } catch (imgError) {
                this.logger.error(`Failed to insert image ${i + 1}:`, imgError);
                // Continue with other images even if one fails
              }
            }
          }
        }
      }

      await queryRunner.commitTransaction();

      // Fetch the complete product
      const completeProduct = await this.getProduct(id);

      return {
        product: completeProduct.product,
        message: 'Product updated successfully',
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Delete product
   */
  async deleteProduct(id: number) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Delete customer product option discounts for this product
      await queryRunner.query('DELETE FROM customer_product_option_discount WHERE product_id = $1', [Number(id)]);

      // Delete customer product discounts for this product
      await queryRunner.query('DELETE FROM customer_product_discount WHERE product_id = $1', [Number(id)]);

      // Delete product reviews
      try {
        await queryRunner.query('DELETE FROM product_review WHERE product_id = $1', [Number(id)]);
      } catch (e) { /* table may not exist */ }

      // Nullify product_option_id in order_product_option (preserve order history)
      try {
        await queryRunner.query(
          `UPDATE order_product_option SET product_option_id = NULL 
           WHERE order_product_id IN (SELECT order_product_id FROM order_product WHERE product_id = $1)`,
          [Number(id)]
        );
      } catch (e) { /* table or column may not exist */ }

      // Nullify product_id in order_product (preserve order history)
      await queryRunner.query('UPDATE order_product SET product_id = NULL WHERE product_id = $1', [Number(id)]);

      // Delete product options first (foreign key constraint)
      await queryRunner.query('DELETE FROM product_option WHERE product_id = $1', [Number(id)]);

      // Delete product categories
      await queryRunner.query('DELETE FROM product_category WHERE product_id = $1', [Number(id)]);

      // Delete product images
      await queryRunner.query('DELETE FROM product_images WHERE product_id = $1', [Number(id)]);

      // Delete product
      const result = await queryRunner.query(
        'DELETE FROM product WHERE product_id = $1 RETURNING *',
        [Number(id)],
      );

      if (result.length === 0) {
        throw new NotFoundException('Product not found');
      }

      await queryRunner.commitTransaction();

      return { message: 'Product deleted successfully' };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * List categories
   */
  async listCategories() {
    const query = `
      SELECT 
        c.*,
        (
          SELECT json_build_object('category_id', pc.category_id, 'category_name', pc.category_name)
          FROM category pc
          WHERE pc.category_id = c.parent_category_id
        ) as parent_category
      FROM category c
      ORDER BY c.category_id
    `;

    const result = await this.dataSource.query(query);
    return { categories: result };
  }

  /**
   * Create category
   */
  async createCategory(data: { category_name: string; parent_category_id?: number }) {
    const { category_name, parent_category_id } = data;

    if (!category_name) {
      throw new BadRequestException('Category name is required');
    }

    const query = `
      INSERT INTO category (category_name, parent_category_id)
      VALUES ($1, $2)
      RETURNING *
    `;

    const result = await this.dataSource.query(query, [category_name, parent_category_id || null]);
    return {
      category: result[0],
      message: 'Category created successfully',
    };
  }

  /**
   * Update category
   */
  async updateCategory(id: number, data: { category_name?: string; parent_category_id?: number }) {
    const { category_name, parent_category_id } = data;

    const query = `
      UPDATE category
      SET 
        category_name = COALESCE($1, category_name),
        parent_category_id = COALESCE($2, parent_category_id)
      WHERE category_id = $3
      RETURNING *
    `;

    const result = await this.dataSource.query(query, [category_name, parent_category_id, Number(id)]);

    if (result.length === 0) {
      throw new NotFoundException('Category not found');
    }

    return {
      category: result[0],
      message: 'Category updated successfully',
    };
  }

  /**
   * Delete category
   */
  async deleteCategory(id: number) {
    const query = 'DELETE FROM category WHERE category_id = $1 RETURNING *';
    const result = await this.dataSource.query(query, [Number(id)]);

    if (result.length === 0) {
      throw new NotFoundException('Category not found');
    }

    return { message: 'Category deleted successfully' };
  }
}
