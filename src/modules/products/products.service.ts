import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Product } from '../../entities/Product';
import { Category } from '../../entities/Category';
import { FileStorageService } from '../../common/services/file-storage.service';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
    @InjectRepository(Category)
    private categoryRepository: Repository<Category>,
    private dataSource: DataSource,
    private fileStorageService: FileStorageService,
  ) {}

  async findAll(query: any): Promise<any> {
    const { limit = 20, offset = 0, search, status } = query;

    let sqlQuery = `
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
              'option_value_id', ov.option_value_id,
              'option_value_name', ov.name,
              'option_price', po.option_price,
              'option_price_prefix', po.option_price_prefix,
              'option_required', po.option_required
            )
          )
          FROM product_option po
          JOIN option_value ov ON po.option_value_id = ov.option_value_id
          JOIN options o ON ov.option_id = o.option_id
          WHERE po.product_id = p.product_id
        ) as options,
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

    if (search) {
      sqlQuery += ` AND (p.product_name ILIKE $${paramIndex} OR p.product_description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (status !== undefined) {
      sqlQuery += ` AND p.product_status = $${paramIndex}`;
      params.push(Number(status));
      paramIndex++;
    }

    sqlQuery += ' ORDER BY p.product_id DESC';
    sqlQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await this.dataSource.query(sqlQuery, params);

    let countQuery = 'SELECT COUNT(*) FROM product p WHERE 1=1';
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
      products: result,
      count,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  async findOne(id: number): Promise<any> {
    const result = await this.dataSource.query(
      `SELECT 
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
              'option_value_id', ov.option_value_id,
              'option_value_name', ov.name,
              'option_price', po.option_price,
              'option_price_prefix', po.option_price_prefix,
              'option_required', po.option_required,
              'discount_percentage', 0
            )
          )
          FROM product_option po
          JOIN option_value ov ON po.option_value_id = ov.option_value_id
          JOIN options o ON ov.option_id = o.option_id
          WHERE po.product_id = p.product_id
        ) as options,
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
      WHERE p.product_id = $1`,
      [id],
    );

    if (result.length === 0) {
      throw new NotFoundException('Product not found');
    }

    return { product: result[0] };
  }

  async create(productData: any, files?: Express.Multer.File[], userId?: number): Promise<any> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const uploadedImageUrls: string[] = [];

      // Handle image uploads
      if (files && Array.isArray(files) && files.length > 0) {
        this.logger.log(`Starting upload of ${files.length} image(s)...`);
        for (const file of files) {
          try {
            const tempProductId = Date.now();
            const result = await this.fileStorageService.uploadProductImage(file.buffer, tempProductId, file.originalname);
            this.logger.log(`✅ Successfully uploaded ${file.originalname}: ${result.url}`);
            uploadedImageUrls.push(result.url);
          } catch (error: any) {
            this.logger.error(`❌ Failed to upload ${file.originalname}:`, error);
            throw new Error(`Failed to upload image ${file.originalname}: ${error.message || error}`);
          }
        }
      }

      // Parse product data
      let parsedData: any = {};
      if (typeof productData.product_name === 'string') {
        parsedData = {
          product_name: productData.product_name,
          product_description: productData.product_description,
          product_price: productData.product_price,
          retail_price: productData.retail_price,
          retail_discount_percentage: productData.retail_discount_percentage,
          customer_type_visibility: productData.customer_type_visibility,
          product_status: productData.product_status,
          user_id: productData.user_id || userId,
          categories: productData.categories
            ? typeof productData.categories === 'string'
              ? JSON.parse(productData.categories)
              : productData.categories
            : [],
          options: productData.options
            ? typeof productData.options === 'string'
              ? JSON.parse(productData.options)
              : productData.options
            : [],
          product_image_url: productData.product_image_url,
          product_images: productData.product_images
            ? typeof productData.product_images === 'string'
              ? JSON.parse(productData.product_images)
              : productData.product_images
            : [],
        };
      } else {
        parsedData = productData;
      }

      const allImageUrls = [...uploadedImageUrls, ...(parsedData.product_images || [])];

      const {
        product_name,
        product_description,
        product_price,
        retail_price,
        retail_discount_percentage,
        customer_type_visibility,
        product_status,
        user_id,
        categories,
        options,
        product_image_url,
      } = parsedData;

      // Validation
      if (!product_name || product_name.trim() === '') {
        throw new BadRequestException('Product name is required');
      }

      if (product_name.length > 255) {
        throw new BadRequestException('Product name must be 255 characters or less');
      }

      if (product_price === undefined || product_price === null || product_price === '') {
        throw new BadRequestException('Product price is required');
      }

      const price = parseFloat(product_price);
      if (isNaN(price) || price < 0 || price > 99999999.99) {
        throw new BadRequestException('Product price must be a valid number between 0 and 99,999,999.99');
      }

      if (product_description && product_description.length > 10000) {
        throw new BadRequestException('Product description must be 10,000 characters or less');
      }

      if (!user_id && !userId) {
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
        const discount = retail_discount_percentage;
        finalRetailPrice = parseFloat(product_price) * (1 - parseFloat(discount) / 100);
      }

      const visibility = customer_type_visibility || 'all';

      // Create product
      const productResult = await queryRunner.query(
        `INSERT INTO product (
          product_name, 
          product_description, 
          product_price,
          retail_price,
          retail_discount_percentage,
          customer_type_visibility,
          product_status,
          user_id,
          product_image,
          product_date_added,
          product_date_modified
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
        RETURNING *`,
        [
          product_name,
          product_description || '',
          product_price,
          finalRetailPrice ? parseFloat(finalRetailPrice.toString()).toFixed(2) : null,
          retail_discount_percentage || null,
          visibility,
          product_status || 1,
          user_id || userId,
          product_image_url || null,
        ],
      );

      const newProduct = productResult.rows[0];

      // Insert categories
      if (categories && Array.isArray(categories) && categories.length > 0) {
        for (const categoryId of categories) {
          await queryRunner.query('INSERT INTO product_category (product_id, category_id) VALUES ($1, $2)', [
            newProduct.product_id,
            categoryId,
          ]);
        }
      }

      // Insert options
      if (options && Array.isArray(options) && options.length > 0) {
        for (const option of options) {
          if (!option.option_value_id) {
            throw new Error(`Missing option_value_id in option: ${JSON.stringify(option)}`);
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

      // Insert product images
      if (allImageUrls && Array.isArray(allImageUrls) && allImageUrls.length > 0) {
        for (let i = 0; i < allImageUrls.length; i++) {
          const imageUrl = allImageUrls[i];
          if (imageUrl && typeof imageUrl === 'string' && imageUrl.trim() !== '') {
            try {
              await queryRunner.query(`INSERT INTO product_images (product_id, image_url, image_order) VALUES ($1, $2, $3)`, [
                newProduct.product_id,
                imageUrl.trim(),
                i,
              ]);
            } catch (imgError) {
              this.logger.error(`Failed to insert image ${i + 1}:`, imgError);
            }
          }
        }
      }

              await queryRunner.commitTransaction();

      // Fetch complete product
      return this.findOne(newProduct.product_id);
    } catch (error) {
              await queryRunner.rollbackTransaction();
      this.logger.error('Create product error:', error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async update(id: number, productData: any, files?: Express.Multer.File[]): Promise<any> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const uploadedImageUrls: string[] = [];

      // Handle image uploads
      if (files && Array.isArray(files) && files.length > 0) {
        for (const file of files) {
          try {
            const result = await this.fileStorageService.uploadProductImage(file.buffer, id, file.originalname);
            uploadedImageUrls.push(result.url);
          } catch (error: any) {
            this.logger.error(`Failed to upload ${file.originalname}:`, error);
          }
        }
      }

      // Parse product data
      let parsedData: any = {};
      if (typeof productData.product_name === 'string') {
        parsedData = {
          product_name: productData.product_name,
          product_description: productData.product_description,
          product_price: productData.product_price,
          retail_price: productData.retail_price,
          retail_discount_percentage: productData.retail_discount_percentage,
          customer_type_visibility: productData.customer_type_visibility,
          product_status: productData.product_status,
          categories: productData.categories
            ? typeof productData.categories === 'string'
              ? JSON.parse(productData.categories)
              : productData.categories
            : undefined,
          options: productData.options
            ? typeof productData.options === 'string'
              ? JSON.parse(productData.options)
              : productData.options
            : undefined,
          product_image_url: productData.product_image_url,
          product_images: productData.product_images
            ? typeof productData.product_images === 'string'
              ? JSON.parse(productData.product_images)
              : productData.product_images
            : undefined,
        };
      } else {
        parsedData = productData;
      }

      const allImageUrls = [...uploadedImageUrls, ...(parsedData.product_images || [])];

      const {
        product_name,
        product_description,
        product_price,
        retail_price,
        retail_discount_percentage,
        customer_type_visibility,
        product_status,
        categories,
        options,
        product_image_url,
      } = parsedData;

      // Validation
      if (product_name !== undefined && product_name !== null) {
        if (product_name.trim() === '') {
          throw new BadRequestException('Product name cannot be empty');
        }
        if (product_name.length > 255) {
          throw new BadRequestException('Product name must be 255 characters or less');
        }
      }

      if (product_price !== undefined && product_price !== null && product_price !== '') {
        const price = parseFloat(product_price);
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

      // Calculate retail_price
      let finalRetailPrice = retail_price;
      if (!finalRetailPrice && product_price && retail_discount_percentage) {
        const discount = retail_discount_percentage;
        finalRetailPrice = parseFloat(product_price) * (1 - parseFloat(discount) / 100);
      }

      // Update product
      const updateQuery = `UPDATE product 
         SET 
           product_name = COALESCE($1, product_name), 
           product_description = COALESCE($2, product_description), 
           product_price = COALESCE($3, product_price),
           retail_price = COALESCE($4, retail_price),
           retail_discount_percentage = COALESCE($5, retail_discount_percentage),
           customer_type_visibility = COALESCE($6, customer_type_visibility),
           product_status = COALESCE($7, product_status),
           product_image = COALESCE($8, product_image),
           product_date_modified = CURRENT_TIMESTAMP
         WHERE product_id = $9
         RETURNING *`;

      const updateParams = [
        product_name,
        product_description,
        product_price,
        finalRetailPrice ? parseFloat(finalRetailPrice.toString()).toFixed(2) : null,
        retail_discount_percentage || null,
        customer_type_visibility || 'all',
        product_status,
        product_image_url,
        id,
      ];

      const result = await queryRunner.query(updateQuery, updateParams);

      if (result.length === 0) {
        throw new NotFoundException('Product not found');
      }

      // Update categories
      if (categories !== undefined && Array.isArray(categories)) {
              await queryRunner.query('DELETE FROM product_category WHERE product_id = $1', [id]);
        for (const categoryId of categories) {
          await queryRunner.query('INSERT INTO product_category (product_id, category_id) VALUES ($1, $2)', [id, categoryId]);
        }
      }

      // Update options
      if (options !== undefined && Array.isArray(options)) {
              await queryRunner.query('DELETE FROM product_option WHERE product_id = $1', [id]);
        for (const option of options) {
          if (!option.option_value_id) {
            throw new Error(`Missing option_value_id in option: ${JSON.stringify(option)}`);
          }
          await queryRunner.query(
            `INSERT INTO product_option (product_id, option_value_id, option_price, option_price_prefix, option_required) 
             VALUES ($1, $2, $3, $4, $5)`,
            [id, option.option_value_id, option.option_price || 0, option.option_price_prefix || '+', option.option_required || 0],
          );
        }
      }

      // Update product images
      if (allImageUrls !== undefined && allImageUrls !== null) {
              await queryRunner.query('DELETE FROM product_images WHERE product_id = $1', [id]);
        if (Array.isArray(allImageUrls) && allImageUrls.length > 0) {
          for (let i = 0; i < allImageUrls.length; i++) {
            const imageUrl = allImageUrls[i];
            if (imageUrl && typeof imageUrl === 'string' && imageUrl.trim() !== '') {
              try {
                await queryRunner.query(`INSERT INTO product_images (product_id, image_url, image_order) VALUES ($1, $2, $3)`, [
                  id,
                  imageUrl.trim(),
                  i,
                ]);
              } catch (imgError) {
                this.logger.error(`Failed to insert image ${i + 1}:`, imgError);
              }
            }
          }
        }
      }

              await queryRunner.commitTransaction();

      return this.findOne(id);
    } catch (error) {
              await queryRunner.rollbackTransaction();
      this.logger.error('Update product error:', error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async delete(id: number): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Delete customer product option discounts for this product
      await queryRunner.query('DELETE FROM customer_product_option_discount WHERE product_id = $1', [id]);

      // Delete customer product discounts for this product
      await queryRunner.query('DELETE FROM customer_product_discount WHERE product_id = $1', [id]);

      // Delete product reviews
      try {
        await queryRunner.query('DELETE FROM product_review WHERE product_id = $1', [id]);
      } catch (e) { /* table may not exist */ }

      // Nullify product_id in order_product (preserve order history)
      await queryRunner.query('UPDATE order_product SET product_id = NULL WHERE product_id = $1', [id]);

      // Delete product options
              await queryRunner.query('DELETE FROM product_option WHERE product_id = $1', [id]);

      // Delete product categories
              await queryRunner.query('DELETE FROM product_category WHERE product_id = $1', [id]);

      // Delete product images
              await queryRunner.query('DELETE FROM product_images WHERE product_id = $1', [id]);

      // Delete product
      const result = await queryRunner.query('DELETE FROM product WHERE product_id = $1 RETURNING *', [id]);

      if (result.length === 0) {
        throw new NotFoundException('Product not found');
      }

              await queryRunner.commitTransaction();
    } catch (error) {
              await queryRunner.rollbackTransaction();
      this.logger.error('Delete product error:', error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // Category methods
  async listCategories(): Promise<any> {
    const categories = await this.dataSource.query(`
      SELECT c.*, pc.category_name as parent_category_name
      FROM category c
      LEFT JOIN category pc ON c.parent_category_id = pc.category_id
      ORDER BY c.category_name
    `);
    return { categories };
  }

  async createCategory(categoryData: { category_name: string; parent_category_id?: number }): Promise<any> {
    const result = await this.dataSource.query(
      `INSERT INTO category (category_name, parent_category_id) VALUES ($1, $2) RETURNING *`,
      [categoryData.category_name, categoryData.parent_category_id || null],
    );
    return { category: result[0], message: 'Category created successfully' };
  }

  async updateCategory(id: number, categoryData: { category_name?: string; parent_category_id?: number }): Promise<any> {
    await this.dataSource.query(
      `UPDATE category SET category_name = COALESCE($1, category_name), parent_category_id = COALESCE($2, parent_category_id) 
       WHERE category_id = $3`,
      [categoryData.category_name, categoryData.parent_category_id, id],
    );
    const category = await this.dataSource.query(`SELECT * FROM category WHERE category_id = $1`, [id]);
    return { category: category[0], message: 'Category updated successfully' };
  }

  async deleteCategory(id: number): Promise<void> {
    await this.dataSource.query('DELETE FROM category WHERE category_id = $1', [id]);
  }
}
