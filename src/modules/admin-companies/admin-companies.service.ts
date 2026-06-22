import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Department } from '../../entities/Department';

@Injectable()
export class AdminCompaniesService {
  private readonly logger = new Logger(AdminCompaniesService.name);

  constructor(
    private dataSource: DataSource,
    @InjectRepository(Department)
    private departmentRepository: Repository<Department>,
  ) {}

  async findAll(query: any): Promise<any> {
    const { limit = 100, offset = 0, search, status } = query;

    await this.ensureCompanyPricingSchema();

    let sqlQuery = 'SELECT * FROM company WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      sqlQuery += ` AND company_name ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (status !== undefined) {
      sqlQuery += ` AND company_status = $${paramIndex}`;
      params.push(Number(status));
      paramIndex++;
    }

    sqlQuery += ' ORDER BY company_name ASC';
    sqlQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await this.dataSource.query(sqlQuery, params);

    let countQuery = 'SELECT COUNT(*) FROM company WHERE 1=1';
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (search) {
      countQuery += ` AND company_name ILIKE $${countParamIndex}`;
      countParams.push(`%${search}%`);
      countParamIndex++;
    }

    if (status !== undefined) {
      countQuery += ` AND company_status = $${countParamIndex}`;
      countParams.push(Number(status));
    }

    const countResult = await this.dataSource.query(countQuery, countParams);
    const count = parseInt(countResult[0].count);

    return { companies: result, count, limit: Number(limit), offset: Number(offset) };
  }

  async findOne(id: number): Promise<any> {
    await this.ensureCompanyPricingSchema();

    const companyResult = await this.dataSource.query('SELECT * FROM company WHERE company_id = $1', [id]);

    if (companyResult.length === 0) {
      throw new NotFoundException('Company not found');
    }

    const departmentsResult = await this.dataSource.query(
      'SELECT * FROM department WHERE company_id = $1 ORDER BY department_name ASC',
      [id],
    );

    return { company: companyResult[0], departments: departmentsResult };
  }

  async create(createCompanyDto: any): Promise<any> {
    if (!createCompanyDto || typeof createCompanyDto !== 'object') {
      throw new BadRequestException('Invalid request body');
    }

    const { company_name, company_abn, company_phone, company_address, company_status, pay_later } = createCompanyDto;

    if (!company_name || (typeof company_name === 'string' && !company_name.trim())) {
      throw new BadRequestException('Company name is required');
    }

    await this.ensureCompanyPricingSchema();

    try {
      const result = await this.dataSource.query(
        `INSERT INTO company (company_name, company_abn, company_phone, company_address, company_status, pay_later, company_created_on) 
         VALUES ($1, $2, $3, $4, $5, $6, NOW()) 
         RETURNING *`,
        [company_name, company_abn || null, company_phone, company_address || null, company_status || 1, pay_later === true],
      );

      return { company: result[0], message: 'Company created successfully' };
    } catch (error: any) {
      if (error.code === '23502' || error.message?.includes('violates not-null constraint')) {
        throw new BadRequestException('Company name is required');
      }
      throw error;
    }
  }

  async update(id: number, updateCompanyDto: any): Promise<any> {
    const { company_name, company_abn, company_phone, company_address, company_status, pay_later } = updateCompanyDto;

    await this.ensureCompanyPricingSchema();

    const result = await this.dataSource.query(
      `UPDATE company 
       SET company_name = $1, company_abn = $2, company_phone = $3, company_address = $4, company_status = COALESCE($5, company_status), pay_later = COALESCE($6, pay_later)
       WHERE company_id = $7
       RETURNING *`,
      [company_name, company_abn || null, company_phone, company_address || null, company_status, pay_later === undefined ? null : pay_later === true, id],
    );

    if (result.length === 0) {
      throw new NotFoundException('Company not found');
    }

    return { company: result[0], message: 'Company updated successfully' };
  }

  async delete(id: number): Promise<void> {
    const result = await this.dataSource.query('DELETE FROM company WHERE company_id = $1 RETURNING *', [id]);

    if (result.length === 0) {
      throw new NotFoundException('Company not found');
    }
  }

  // Department methods
  async listDepartments(company_id?: number): Promise<any> {
    let query = `
      SELECT d.*, c.company_name 
      FROM department d
      LEFT JOIN company c ON d.company_id = c.company_id
    `;
    const params: any[] = [];

    if (company_id) {
      query += ' WHERE d.company_id = $1';
      params.push(Number(company_id));
    }

    query += ' ORDER BY d.department_name ASC';

    const result = await this.dataSource.query(query, params);
    return { departments: result };
  }

  async createDepartment(createDepartmentDto: any): Promise<any> {
    const { department_name, company_id, comments } = createDepartmentDto;

    if (!department_name || !department_name.trim()) {
      throw new BadRequestException('Department name is required');
    }

    if (!company_id) {
      throw new BadRequestException('Company ID is required');
    }

    const companyCheck = await this.dataSource.query('SELECT company_id FROM company WHERE company_id = $1', [
      Number(company_id),
    ]);

    if (companyCheck.length === 0) {
      throw new NotFoundException('Company not found');
    }

    try {
      // Insert department with all columns (after migration, all columns should exist)
      const result = await this.dataSource.query(
        `INSERT INTO department (department_name, company_id, department_comments, department_created_on, department_modified_on) 
         VALUES ($1, $2, $3, NOW(), NOW()) 
         RETURNING *`,
        [department_name.trim(), Number(company_id), comments?.trim() || null],
      );

      return { department: result[0], message: 'Department created successfully' };
    } catch (error: any) {
      if (error.code === '23505') {
        throw new BadRequestException('Department name already exists for this company');
      }
      if (error.code === '23503') {
        throw new BadRequestException('Invalid company ID');
      }
      // If column doesn't exist error, provide helpful message
      if (error.code === '42703') {
        this.logger.error('Department table missing required columns. Please run migration 020_add_department_columns.sql');
        throw new BadRequestException('Database schema is out of date. Please contact administrator.');
      }
      throw error;
    }
  }

  async updateDepartment(id: number, updateDepartmentDto: any): Promise<any> {
    const { department_name, company_id, comments } = updateDepartmentDto;

    // Validation - department_name is required, company_id is optional (can update just name)
    if (!department_name || !department_name.trim()) {
      throw new BadRequestException('Department name is required');
    }

    // Check if department exists and get current company_id if not provided
    const departmentCheck = await this.dataSource.query('SELECT department_id, company_id FROM department WHERE department_id = $1', [
      Number(id),
    ]);

    if (departmentCheck.length === 0) {
      throw new NotFoundException('Department not found');
    }

    const currentCompanyId = departmentCheck[0].company_id;
    const finalCompanyId = company_id !== undefined ? Number(company_id) : currentCompanyId;

    // Check if company exists (only if company_id is being updated)
    if (company_id !== undefined) {
      const companyCheck = await this.dataSource.query('SELECT company_id FROM company WHERE company_id = $1', [
        finalCompanyId,
      ]);

      if (companyCheck.length === 0) {
        throw new NotFoundException('Company not found');
      }
    }

    try {
      // Update department with all columns (after migration, all columns should exist)
      const result = await this.dataSource.query(
        `UPDATE department 
         SET department_name = $1, company_id = $2, department_comments = $3, department_modified_on = NOW()
         WHERE department_id = $4
         RETURNING *`,
        [department_name.trim(), finalCompanyId, comments?.trim() || null, Number(id)],
      );

      if (result.length === 0) {
        throw new NotFoundException('Department not found');
      }

      return { department: result[0], message: 'Department updated successfully' };
    } catch (error: any) {
      if (error.code === '23505') {
        throw new BadRequestException('Department name already exists for this company');
      }
      if (error.code === '23503') {
        throw new BadRequestException('Invalid company ID');
      }
      // If column doesn't exist error, provide helpful message
      if (error.code === '42703') {
        this.logger.error('Department table missing required columns. Please run migration 020_add_department_columns.sql');
        throw new BadRequestException('Database schema is out of date. Please contact administrator.');
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Company-level pricing (discounts) + pay_later
  // ---------------------------------------------------------------------------

  /**
   * Ensure the company-pricing schema exists (lazy migration).
   * Creates the company discount tables and the pay_later column if missing.
   */
  private async ensureCompanyPricingSchema(): Promise<void> {
    try {
      await this.dataSource.query(
        `ALTER TABLE company ADD COLUMN IF NOT EXISTS pay_later boolean NOT NULL DEFAULT false`,
      );

      await this.dataSource.query(
        `ALTER TABLE product ADD COLUMN IF NOT EXISTS product_code varchar(100)`,
      );

      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS company_product_discount (
          company_product_discount_id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL,
          product_id INTEGER NOT NULL,
          discount_percentage NUMERIC(5,2) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT uq_company_product_discount UNIQUE (company_id, product_id)
        )
      `);

      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS company_product_option_discount (
          company_product_option_discount_id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL,
          product_id INTEGER NOT NULL,
          option_value_id INTEGER NOT NULL,
          discount_percentage NUMERIC(5,2) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT uq_company_product_option_discount UNIQUE (company_id, product_id, option_value_id)
        )
      `);
    } catch (error) {
      this.logger.error('Error ensuring company pricing schema:', error);
    }
  }

  /**
   * Get all products with their options and the company's existing discounts.
   * Mirrors the customer-level discount editor.
   */
  async getCompanyProductOptionDiscounts(companyId: number): Promise<any> {
    await this.ensureCompanyPricingSchema();

    // Company pricing uses the standard (retail) base price as the reference.
    const productsWithOptionsQuery = `
      SELECT 
        p.product_id, 
        p.product_name,
        p.product_code,
        p.product_price,
        (
          SELECT c.category_name
          FROM product_category pc
          JOIN category c ON pc.category_id = c.category_id
          WHERE pc.product_id = p.product_id
          ORDER BY c.sort_order, c.category_id
          LIMIT 1
        ) as category_name,
        (
          SELECT COALESCE(MIN(c.sort_order), 9999)
          FROM product_category pc
          JOIN category c ON pc.category_id = c.category_id
          WHERE pc.product_id = p.product_id
        ) as category_sort_order,
        (
          SELECT sc.category_name FROM category sc WHERE sc.category_id = p.subcategory_id
        ) as subcategory_name,
        (
          SELECT json_agg(
            json_build_object(
              'product_option_id', po.product_option_id,
              'option_value_id', ov.option_value_id,
              'option_value_name', ov.name,
              'option_base_price', COALESCE(ov.standard_price, po.option_price, 0),
              'option_price', COALESCE(ov.standard_price, po.option_price, 0),
              'option_price_prefix', po.option_price_prefix,
              'discount_percentage', COALESCE(cpod.discount_percentage, 0),
              'company_product_option_discount_id', cpod.company_product_option_discount_id
            ) ORDER BY ov.sort_order
          )
          FROM product_option po
          JOIN option_value ov ON po.option_value_id = ov.option_value_id
          LEFT JOIN company_product_option_discount cpod 
            ON cpod.company_id = $1 
            AND cpod.product_id = p.product_id 
            AND cpod.option_value_id = ov.option_value_id
          WHERE po.product_id = p.product_id
        ) as options
      FROM product p
      WHERE p.product_status = 1
        AND EXISTS (
          SELECT 1 FROM product_option po WHERE po.product_id = p.product_id
        )
      ORDER BY category_sort_order, category_name NULLS LAST, p.product_name
    `;

    const productsWithoutOptionsQuery = `
      SELECT 
        p.product_id, 
        p.product_name,
        p.product_code,
        p.product_price,
        (
          SELECT c.category_name
          FROM product_category pc
          JOIN category c ON pc.category_id = c.category_id
          WHERE pc.product_id = p.product_id
          ORDER BY c.sort_order, c.category_id
          LIMIT 1
        ) as category_name,
        (
          SELECT COALESCE(MIN(c.sort_order), 9999)
          FROM product_category pc
          JOIN category c ON pc.category_id = c.category_id
          WHERE pc.product_id = p.product_id
        ) as category_sort_order,
        (
          SELECT sc.category_name FROM category sc WHERE sc.category_id = p.subcategory_id
        ) as subcategory_name,
        COALESCE(cpd.discount_percentage, 0) as discount_percentage,
        cpd.company_product_discount_id
      FROM product p
      LEFT JOIN company_product_discount cpd 
        ON cpd.company_id = $1 
        AND cpd.product_id = p.product_id
      WHERE p.product_status = 1
        AND NOT EXISTS (
          SELECT 1 FROM product_option po WHERE po.product_id = p.product_id
        )
      ORDER BY category_sort_order, category_name NULLS LAST, p.product_name
    `;

    const [productsWithOptionsResult, productsWithoutOptionsResult] = await Promise.all([
      this.dataSource.query(productsWithOptionsQuery, [companyId]),
      this.dataSource.query(productsWithoutOptionsQuery, [companyId]),
    ]);

    const productsWithOptions = productsWithOptionsResult.map((p: any) => ({
      product_id: p.product_id,
      product_name: p.product_name,
      product_code: p.product_code || null,
      category_name: p.category_name || null,
      category_sort_order: p.category_sort_order != null ? Number(p.category_sort_order) : 9999,
      subcategory_name: p.subcategory_name || null,
      product_price: parseFloat(p.product_price || 0),
      options: p.options || [],
      has_options: true,
    }));

    const productsWithoutOptions = productsWithoutOptionsResult.map((p: any) => ({
      product_id: p.product_id,
      product_name: p.product_name,
      product_code: p.product_code || null,
      category_name: p.category_name || null,
      category_sort_order: p.category_sort_order != null ? Number(p.category_sort_order) : 9999,
      subcategory_name: p.subcategory_name || null,
      product_price: parseFloat(p.product_price || 0),
      discount_percentage: parseFloat(p.discount_percentage || 0),
      company_product_discount_id: p.company_product_discount_id,
      has_options: false,
    }));

    const allProducts = [...productsWithOptions, ...productsWithoutOptions].sort((a, b) => {
      if (a.category_sort_order !== b.category_sort_order) {
        return a.category_sort_order - b.category_sort_order;
      }
      const catA = a.category_name || '';
      const catB = b.category_name || '';
      if (catA !== catB) return catA.localeCompare(catB);
      return a.product_name.localeCompare(b.product_name);
    });

    return {
      products: allProducts,
      productsWithOptions,
      productsWithoutOptions,
    };
  }

  /**
   * Replace the company's product-level and option-level discounts.
   */
  async setCompanyProductOptionDiscounts(companyId: number, discounts: any[]): Promise<any> {
    await this.ensureCompanyPricingSchema();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const optionDiscounts = discounts.filter(
        (d) => d.option_value_id !== undefined && d.option_value_id !== null,
      );
      const productDiscounts = discounts.filter(
        (d) => d.option_value_id === undefined || d.option_value_id === null,
      );

      await queryRunner.query('DELETE FROM company_product_option_discount WHERE company_id = $1', [companyId]);
      await queryRunner.query('DELETE FROM company_product_discount WHERE company_id = $1', [companyId]);

      for (const discount of optionDiscounts) {
        if (discount.discount_percentage > 0) {
          await queryRunner.query(
            `INSERT INTO company_product_option_discount (company_id, product_id, option_value_id, discount_percentage)
             VALUES ($1, $2, $3, $4)`,
            [companyId, discount.product_id, discount.option_value_id, discount.discount_percentage],
          );
        }
      }

      for (const discount of productDiscounts) {
        if (discount.discount_percentage > 0) {
          await queryRunner.query(
            `INSERT INTO company_product_discount (company_id, product_id, discount_percentage)
             VALUES ($1, $2, $3)
             ON CONFLICT (company_id, product_id) 
             DO UPDATE SET discount_percentage = EXCLUDED.discount_percentage, updated_at = CURRENT_TIMESTAMP`,
            [companyId, discount.product_id, discount.discount_percentage],
          );
        }
      }

      await queryRunner.commitTransaction();
      return { message: 'Company product and option discounts updated successfully' };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
