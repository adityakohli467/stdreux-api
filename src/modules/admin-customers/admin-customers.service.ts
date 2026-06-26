import { Injectable, Logger, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Customer } from '../../entities/Customer';
import { EmailService } from '../../common/services/email.service';
import { NotificationService } from '../../common/services/notification.service';

@Injectable()
export class AdminCustomersService implements OnModuleInit {
  private readonly logger = new Logger(AdminCustomersService.name);

  constructor(
    @InjectRepository(Customer)
    private customerRepository: Repository<Customer>,
    private dataSource: DataSource,
    private configService: ConfigService,
    private emailService: EmailService,
    private notificationService: NotificationService,
  ) { }

  async onModuleInit() {
    try {
      await this.dataSource.query(`
        ALTER TABLE customer 
        ADD COLUMN IF NOT EXISTS pay_later BOOLEAN DEFAULT false
      `);
      this.logger.log('Ensured pay_later column exists in customer table');
    } catch (error) {
      this.logger.error('Failed to add pay_later column:', error);
    }
  }

  async findAll(query: any): Promise<any> {
    const { limit = 20, offset = 0, search, company_id, customer_type, archived = 'false', department_id } = query;

    // Check which columns exist
    const columnCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'customer' 
      AND column_name IN ('customer_type', 'archived', 'department_id', 'discount_percentage', 'wholesale_discount_percentage', 'pay_later')
    `);
    const existingColumns = columnCheck.map((row: any) => row.column_name);
    const hasCustomerType = existingColumns.includes('customer_type');
    const hasArchived = existingColumns.includes('archived');
    const hasDepartmentId = existingColumns.includes('department_id');
    const hasDiscountPercentage = existingColumns.includes('discount_percentage');
    const hasWholesaleDiscountPercentage = existingColumns.includes('wholesale_discount_percentage');
    const hasPayLater = existingColumns.includes('pay_later');

    const discountColumn = hasDiscountPercentage
      ? 'c.discount_percentage'
      : hasWholesaleDiscountPercentage
        ? 'c.wholesale_discount_percentage'
        : 'NULL';

    // Check if created_from and approved columns exist
    const createdFromCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'customer' 
      AND column_name IN ('created_from', 'approved')
    `);
    const hasCreatedFrom = createdFromCheck.some((row: any) => row.column_name === 'created_from');
    const hasApproved = createdFromCheck.some((row: any) => row.column_name === 'approved');

    let sqlQuery = `
      SELECT 
        c.*,
        ${discountColumn} as discount_percentage,
        co.company_name,
        ${hasDepartmentId ? 'd.department_name,' : 'NULL as department_name,'}
        u.email as user_email,
        u.username as user_username,
        ${hasCreatedFrom ? 'c.created_from' : "'admin' as created_from"},
        ${hasApproved ? 'COALESCE(c.approved, false) as approved' : 'false as approved'},
        ${hasPayLater ? 'COALESCE(c.pay_later, false) as pay_later' : 'false as pay_later'}
      FROM customer c
      LEFT JOIN company co ON c.company_id = co.company_id
      ${hasDepartmentId ? 'LEFT JOIN department d ON c.department_id = d.department_id' : ''}
      LEFT JOIN "user" u ON c.user_id = u.user_id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      sqlQuery += ` AND (c.firstname ILIKE $${paramIndex} OR c.lastname ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR c.telephone ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (company_id) {
      sqlQuery += ` AND c.company_id = $${paramIndex}`;
      params.push(Number(company_id));
      paramIndex++;
    }

    if (customer_type && customer_type.trim() !== '' && hasCustomerType) {
      sqlQuery += ` AND c.customer_type = $${paramIndex}`;
      params.push(customer_type.trim());
      paramIndex++;
    }

    if (department_id && hasDepartmentId) {
      sqlQuery += ` AND c.department_id = $${paramIndex}`;
      params.push(Number(department_id));
      paramIndex++;
    }

    if (hasArchived) {
      const isArchived = archived === 'true';
      sqlQuery += ` AND COALESCE(c.archived, false) = $${paramIndex}`;
      params.push(isArchived);
      paramIndex++;
    }

    // Exclude pending approval customers from active list
    // Pending approval = created_from = 'storefront' AND approved = false
    // Only exclude when fetching active (not archived) customers
    if (hasCreatedFrom && hasApproved && archived !== 'true') {
      sqlQuery += ` AND NOT (c.created_from = 'storefront' AND COALESCE(c.approved, false) = false)`;
    }

    sqlQuery += ' ORDER BY c.firstname ASC, c.lastname ASC';
    sqlQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await this.dataSource.query(sqlQuery, params);

    // Get count
    let countQuery = 'SELECT COUNT(*) FROM customer c WHERE 1=1';
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (search) {
      countQuery += ` AND (c.firstname ILIKE $${countParamIndex} OR c.lastname ILIKE $${countParamIndex} OR c.email ILIKE $${countParamIndex} OR c.telephone ILIKE $${countParamIndex})`;
      countParams.push(`%${search}%`);
      countParamIndex++;
    }

    if (company_id) {
      countQuery += ` AND c.company_id = $${countParamIndex}`;
      countParams.push(Number(company_id));
      countParamIndex++;
    }

    if (customer_type && customer_type.trim() !== '' && hasCustomerType) {
      countQuery += ` AND c.customer_type = $${countParamIndex}`;
      countParams.push(customer_type.trim());
      countParamIndex++;
    }

    if (department_id && hasDepartmentId) {
      countQuery += ` AND c.department_id = $${countParamIndex}`;
      countParams.push(Number(department_id));
      countParamIndex++;
    }

    if (hasArchived) {
      const isArchived = archived === 'true';
      countQuery += ` AND COALESCE(c.archived, false) = $${countParamIndex}`;
      countParams.push(isArchived);
    }

    // Exclude pending approval customers from active count
    // Pending approval = created_from = 'storefront' AND approved = false
    // Only exclude when fetching active (not archived) customers
    // Reuse the hasCreatedFrom and hasApproved checks from above
    if (hasCreatedFrom && hasApproved && archived !== 'true') {
      countQuery += ` AND NOT (c.created_from = 'storefront' AND COALESCE(c.approved, false) = false)`;
    }

    const countResult = await this.dataSource.query(countQuery, countParams);
    const count = parseInt(countResult[0].count);

    return { customers: result, count, limit: Number(limit), offset: Number(offset) };
  }

  async findOne(id: number): Promise<any> {
    const columnCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'customer' 
      AND column_name IN ('department_id', 'discount_percentage', 'wholesale_discount_percentage', 'pay_later')
    `);
    const hasDepartmentId = columnCheck.some((row: any) => row.column_name === 'department_id');
    const hasDiscountPercentage = columnCheck.some((row: any) => row.column_name === 'discount_percentage');
    const hasWholesaleDiscountPercentage = columnCheck.some((row: any) => row.column_name === 'wholesale_discount_percentage');
    const hasPayLater = columnCheck.some((row: any) => row.column_name === 'pay_later');

    const discountColumn = hasDiscountPercentage
      ? 'c.discount_percentage'
      : hasWholesaleDiscountPercentage
        ? 'c.wholesale_discount_percentage'
        : 'NULL';

    const result = await this.dataSource.query(
      `
      SELECT 
        c.*,
        ${discountColumn} as discount_percentage,
        co.company_name,
        ${hasDepartmentId ? 'd.department_name,' : 'NULL as department_name,'}
        u.email as user_email,
        u.username as user_username,
        ${hasPayLater ? 'COALESCE(c.pay_later, false) as pay_later' : 'false as pay_later'}
      FROM customer c
      LEFT JOIN company co ON c.company_id = co.company_id
      ${hasDepartmentId ? 'LEFT JOIN department d ON c.department_id = d.department_id' : ''}
      LEFT JOIN "user" u ON c.user_id = u.user_id
      WHERE c.customer_id = $1
    `,
      [id],
    );

    if (result.length === 0) {
      throw new NotFoundException('Customer not found');
    }

    return { customer: result[0] };
  }

  async create(createCustomerDto: any): Promise<any> {
    const {
      firstname,
      lastname,
      email,
      telephone,
      customer_address,
      customer_type,
      customer_notes,
      customer_cost_centre,
      company_id,
      department_id,
      estimated_opening_date,
      status,
      archived,
      discount_percentage,
      pay_later,
    } = createCustomerDto;

    if (!firstname || !firstname.trim()) {
      throw new BadRequestException('First name is required');
    }

    // Check which discount column exists
    const columnCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'customer' 
      AND column_name IN ('discount_percentage', 'wholesale_discount_percentage')
    `);
    const hasDiscountPercentage = columnCheck.some((row: any) => row.column_name === 'discount_percentage');
    const hasWholesaleDiscountPercentage = columnCheck.some((row: any) => row.column_name === 'wholesale_discount_percentage');

    const discountColumn = hasDiscountPercentage ? 'discount_percentage' : hasWholesaleDiscountPercentage ? 'wholesale_discount_percentage' : null;

    // Check if created_from column exists
    const createdFromCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'customer' 
      AND column_name IN ('created_from', 'pay_later')
    `);
    const hasCreatedFrom = createdFromCheck.some((row: any) => row.column_name === 'created_from');
    const hasPayLaterCol = createdFromCheck.some((row: any) => row.column_name === 'pay_later');

    // Build dynamic query parts
    const columns: string[] = [
      'firstname', 'lastname', 'email', 'telephone', 'customer_address',
      'company_id', 'department_id', 'customer_type', 'customer_notes',
      'customer_cost_centre', 'estimated_opening_date', 'status'
    ];
    const placeholders: string[] = [];
    const values: any[] = [
      firstname.trim(),
      lastname ? lastname.trim() : '',
      email ? email.trim() : null,
      telephone ? telephone.trim() : null,
      customer_address ? customer_address.trim() : null,
      company_id ? Number(company_id) : null,
      department_id ? Number(department_id) : null,
      customer_type || 'Retail',
      customer_notes ? customer_notes.trim() : null,
      customer_cost_centre ? customer_cost_centre.trim() : null,
      estimated_opening_date || null,
      status || 1,
    ];

    let paramIndex = values.length + 1;

    if (discountColumn) {
      columns.push(discountColumn);
      const discountValue =
        discount_percentage !== undefined && discount_percentage !== null && discount_percentage !== ''
          ? discount_percentage >= 0 && discount_percentage <= 100
            ? Number(discount_percentage)
            : null
          : null;
      values.push(discountValue);
      paramIndex++;
    }

    if (hasCreatedFrom) {
      columns.push('created_from');
      values.push('admin');
      paramIndex++;
    }

    if (hasPayLaterCol) {
      columns.push('pay_later');
      values.push(pay_later === true || pay_later === 'true');
      paramIndex++;
    }

    // Build placeholders
    for (let i = 1; i <= values.length; i++) {
      placeholders.push(`$${i}`);
    }

    const query = `
      INSERT INTO customer (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING *
    `;

    try {
      const result = await this.dataSource.query(query, values);
      return { customer: result[0], message: 'Customer created successfully' };
    } catch (error: any) {
      if (error.code === '23503') {
        throw new BadRequestException('Invalid company or department ID');
      }
      if (error.code === '23505') {
        throw new BadRequestException('Customer with this email already exists');
      }
      throw error;
    }
  }

  async update(id: number, updateCustomerDto: any): Promise<any> {
    const columnCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'customer' 
      AND column_name IN ('customer_type', 'customer_notes', 'customer_cost_centre', 'department_id', 'estimated_opening_date', 'archived', 'discount_percentage', 'wholesale_discount_percentage', 'pay_later', 'wholesale_type', 'service_type')
    `);
    const existingColumns = columnCheck.map((row: any) => row.column_name);
    const hasCustomerType = existingColumns.includes('customer_type');
    const hasCustomerNotes = existingColumns.includes('customer_notes');
    const hasCostCentre = existingColumns.includes('customer_cost_centre');
    const hasDepartmentId = existingColumns.includes('department_id');
    const hasEstimatedDate = existingColumns.includes('estimated_opening_date');
    const hasArchived = existingColumns.includes('archived');
    const hasDiscountPercentage = existingColumns.includes('discount_percentage');
    const hasWholesaleDiscountPercentage = existingColumns.includes('wholesale_discount_percentage');
    const hasPayLaterCol = existingColumns.includes('pay_later');
    const hasWholesaleType = existingColumns.includes('wholesale_type');
    const hasServiceType = existingColumns.includes('service_type');

    // Validate required fields if they're being updated
    if (updateCustomerDto.firstname !== undefined && (!updateCustomerDto.firstname || !updateCustomerDto.firstname.trim())) {
      throw new BadRequestException('First name is required');
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updateCustomerDto.firstname !== undefined) {
      updates.push(`firstname = $${paramIndex++}`);
      values.push(updateCustomerDto.firstname.trim());
    }

    if (updateCustomerDto.lastname !== undefined) {
      updates.push(`lastname = $${paramIndex++}`);
      values.push(updateCustomerDto.lastname ? updateCustomerDto.lastname.trim() : '');
    }

    updates.push(`email = $${paramIndex++}`);
    values.push(updateCustomerDto.email ? updateCustomerDto.email.trim() : null);

    updates.push(`telephone = $${paramIndex++}`);
    values.push(updateCustomerDto.telephone ? updateCustomerDto.telephone.trim() : null);

    updates.push(`customer_address = $${paramIndex++}`);
    values.push(updateCustomerDto.customer_address ? updateCustomerDto.customer_address.trim() : null);

    updates.push(`company_id = $${paramIndex++}`);
    values.push(updateCustomerDto.company_id ? Number(updateCustomerDto.company_id) : null);

    if (hasCustomerType && updateCustomerDto.customer_type !== undefined) {
      updates.push(`customer_type = $${paramIndex++}`);
      values.push(updateCustomerDto.customer_type ? updateCustomerDto.customer_type.trim() : null);
    }

    if (hasCustomerNotes && updateCustomerDto.customer_notes !== undefined) {
      updates.push(`customer_notes = $${paramIndex++}`);
      values.push(updateCustomerDto.customer_notes ? updateCustomerDto.customer_notes.trim() : null);
    }

    if (hasCostCentre && updateCustomerDto.customer_cost_centre !== undefined) {
      updates.push(`customer_cost_centre = $${paramIndex++}`);
      values.push(updateCustomerDto.customer_cost_centre ? updateCustomerDto.customer_cost_centre.trim() : null);
    }

    if (hasDepartmentId && updateCustomerDto.department_id !== undefined) {
      updates.push(`department_id = $${paramIndex++}`);
      values.push(updateCustomerDto.department_id ? Number(updateCustomerDto.department_id) : null);
    }

    if (hasEstimatedDate && updateCustomerDto.estimated_opening_date !== undefined) {
      updates.push(`estimated_opening_date = $${paramIndex++}`);
      values.push(updateCustomerDto.estimated_opening_date || null);
    }

    if (updateCustomerDto.status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(updateCustomerDto.status || 1);
    }

    if (hasArchived && updateCustomerDto.archived !== undefined) {
      updates.push(`archived = $${paramIndex++}`);
      values.push(updateCustomerDto.archived === true || updateCustomerDto.archived === 'true');
    }

    if (hasPayLaterCol && updateCustomerDto.pay_later !== undefined) {
      updates.push(`pay_later = $${paramIndex++}`);
      values.push(updateCustomerDto.pay_later === true || updateCustomerDto.pay_later === 'true');
    }

    if (hasDiscountPercentage && updateCustomerDto.discount_percentage !== undefined) {
      const discountValue =
        updateCustomerDto.discount_percentage === null || updateCustomerDto.discount_percentage === ''
          ? null
          : updateCustomerDto.discount_percentage >= 0 && updateCustomerDto.discount_percentage <= 100
            ? Number(updateCustomerDto.discount_percentage)
            : null;
      updates.push(`discount_percentage = $${paramIndex++}`);
      values.push(discountValue);
    } else if (hasWholesaleDiscountPercentage && updateCustomerDto.discount_percentage !== undefined) {
      const discountValue =
        updateCustomerDto.discount_percentage === null || updateCustomerDto.discount_percentage === ''
          ? null
          : updateCustomerDto.discount_percentage >= 0 && updateCustomerDto.discount_percentage <= 100
            ? Number(updateCustomerDto.discount_percentage)
            : null;
      updates.push(`wholesale_discount_percentage = $${paramIndex++}`);
      values.push(discountValue);
    }

    if (hasWholesaleType && updateCustomerDto.wholesale_type !== undefined) {
      updates.push(`wholesale_type = $${paramIndex++}`);
      values.push(updateCustomerDto.wholesale_type || null);
    }

    if (hasServiceType && updateCustomerDto.service_type !== undefined) {
      updates.push(`service_type = $${paramIndex++}`);
      values.push(updateCustomerDto.service_type || null);
    }

    values.push(id);

    const query = `
      UPDATE customer SET
        ${updates.join(', ')}
      WHERE customer_id = $${paramIndex}
      RETURNING *
    `;

    const result = await this.dataSource.query(query, values);

    return { customer: result[0], message: 'Customer updated successfully' };
  }

  async archive(id: number): Promise<void> {
    await this.dataSource.query('UPDATE customer SET archived = true WHERE customer_id = $1', [id]);
  }

  async restore(id: number): Promise<void> {
    await this.dataSource.query('UPDATE customer SET archived = false WHERE customer_id = $1', [id]);
  }

  async delete(id: number): Promise<void> {
    // Check if customer exists (also grab the linked login user_id so we can remove
    // the orphaned "user" record afterwards - otherwise the email stays registered
    // and blocks re-registration from the storefront).
    const customer = await this.dataSource.query('SELECT customer_id, user_id FROM customer WHERE customer_id = $1', [id]);
    if (!customer.length) {
      throw new NotFoundException('Customer not found');
    }
    const linkedUserId: number | null = customer[0].user_id ?? null;

    // Delete related records to avoid foreign key constraint violations
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Delete customer product option discounts
      await queryRunner.query('DELETE FROM customer_product_option_discount WHERE customer_id = $1', [id]);
      // Delete customer product discounts
      await queryRunner.query('DELETE FROM customer_product_discount WHERE customer_id = $1', [id]);
      // Delete API history records
      try {
        await queryRunner.query('DELETE FROM api_history WHERE customer_id = $1', [id]);
      } catch (e) { /* table may not exist or too many records */ }
      // Nullify customer_id in payment_history (preserve payment records)
      await queryRunner.query('UPDATE payment_history SET customer_id = NULL WHERE customer_id = $1', [id]);
      // Nullify customer_id in product reviews (preserve reviews)
      try {
        await queryRunner.query('UPDATE product_review SET customer_id = NULL WHERE customer_id = $1', [id]);
      } catch (e) { /* table may not exist */ }
      // Nullify customer_id on orders (preserve orders for record-keeping)
      await queryRunner.query('UPDATE orders SET customer_id = NULL WHERE customer_id = $1', [id]);
      // Nullify user_id on orders placed by this customer (if user_id references customer)
      try {
        await queryRunner.query('UPDATE orders SET user_id = NULL WHERE user_id = (SELECT user_id FROM customer WHERE customer_id = $1)', [id]);
      } catch (e) { /* ignore */ }
      // Delete notifications referencing this customer's orders
      try {
        await queryRunner.query('DELETE FROM notification WHERE userid = (SELECT user_id FROM customer WHERE customer_id = $1)', [id]);
      } catch (e) { /* table may not exist */ }
      // Delete the customer
      await queryRunner.query('DELETE FROM customer WHERE customer_id = $1', [id]);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    // Remove the orphaned login user so the email/username is freed up and no longer
    // appears as "already registered" when the storefront tries to create a new account.
    // Done outside the main transaction (best-effort) so the customer deletion above is
    // never rolled back by an unexpected foreign-key reference.
    if (linkedUserId) {
      try {
        // Clear remaining references to the user before removing it
        await this.dataSource.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [linkedUserId]).catch(() => {});
        await this.dataSource.query('UPDATE api_history SET user_id = NULL WHERE user_id = $1', [linkedUserId]).catch(() => {});
        await this.dataSource.query('UPDATE company SET user_id = NULL WHERE user_id = $1', [linkedUserId]).catch(() => {});
        await this.dataSource.query('UPDATE orders SET user_id = NULL WHERE user_id = $1', [linkedUserId]).catch(() => {});

        await this.dataSource.query('DELETE FROM "user" WHERE user_id = $1', [linkedUserId]);
      } catch (err) {
        // If the user row can't be hard-deleted (e.g. an unknown FK still references it),
        // fall back to anonymising it so the original email/username is freed for re-use.
        await this.dataSource
          .query(
            `UPDATE "user"
             SET email = CONCAT('deleted_', user_id, '@deleted.local'),
                 login_username = CONCAT('deleted_', user_id),
                 is_customer = 0
             WHERE user_id = $1`,
            [linkedUserId],
          )
          .catch(() => {});
      }
    }
  }

  async getWholesaleCustomers(query: any): Promise<any> {
    return this.findAll({ ...query, customer_type: 'Wholesale' });
  }

  async getCustomerProductOptionDiscounts(customerId: number): Promise<any> {
    // Get customer type to determine which price to use
    const customerQuery = `SELECT customer_type FROM customer WHERE customer_id = $1`;
    const customerResult = await this.dataSource.query(customerQuery, [customerId]);
    const customer = customerResult[0];
    const isWholesale = customer?.customer_type?.includes('Wholesale') || false;

    // Get all products with their options and existing discounts
    const productsWithOptionsQuery = `
      SELECT 
        p.product_id, 
        p.product_name,
        (
          SELECT json_agg(
            json_build_object(
              'product_option_id', po.product_option_id,
              'option_value_id', ov.option_value_id,
              'option_value_name', ov.name,
              'option_base_price', CASE 
                  WHEN $2 = true THEN COALESCE(ov.wholesale_price, po.option_price, 0)
                  ELSE COALESCE(ov.standard_price, po.option_price, 0)
                END,
              'option_price', CASE 
                  WHEN $2 = true THEN COALESCE(ov.wholesale_price, po.option_price, 0)
                  ELSE COALESCE(ov.standard_price, po.option_price, 0)
                END,
              'option_price_prefix', po.option_price_prefix,
              'discount_percentage', COALESCE(cpod.discount_percentage, 0),
              'customer_product_option_discount_id', cpod.customer_product_option_discount_id
            ) ORDER BY ov.sort_order
          )
          FROM product_option po
          JOIN option_value ov ON po.option_value_id = ov.option_value_id
          LEFT JOIN customer_product_option_discount cpod 
            ON cpod.customer_id = $1 
            AND cpod.product_id = p.product_id 
            AND cpod.option_value_id = ov.option_value_id
          WHERE po.product_id = p.product_id
        ) as options
      FROM product p
      WHERE p.product_status = 1
        AND EXISTS (
          SELECT 1 FROM product_option po WHERE po.product_id = p.product_id
        )
      ORDER BY p.product_name
    `;

    // Get products WITHOUT options and their product-level discounts
    const productsWithoutOptionsQuery = `
      SELECT 
        p.product_id, 
        p.product_name,
        p.product_price,
        COALESCE(cpd.discount_percentage, 0) as discount_percentage,
        cpd.customer_product_discount_id
      FROM product p
      LEFT JOIN customer_product_discount cpd 
        ON cpd.customer_id = $1 
        AND cpd.product_id = p.product_id
      WHERE p.product_status = 1
        AND NOT EXISTS (
          SELECT 1 FROM product_option po WHERE po.product_id = p.product_id
        )
      ORDER BY p.product_name
    `;

    const [productsWithOptionsResult, productsWithoutOptionsResult] = await Promise.all([
      this.dataSource.query(productsWithOptionsQuery, [customerId, isWholesale]),
      this.dataSource.query(productsWithoutOptionsQuery, [customerId])
    ]);

    // Format products with options
    const productsWithOptions = productsWithOptionsResult.map((p: any) => ({
      product_id: p.product_id,
      product_name: p.product_name,
      options: p.options || [],
      has_options: true
    }));

    // Format products without options
    const productsWithoutOptions = productsWithoutOptionsResult.map((p: any) => ({
      product_id: p.product_id,
      product_name: p.product_name,
      product_price: parseFloat(p.product_price || 0),
      discount_percentage: parseFloat(p.discount_percentage || 0),
      customer_product_discount_id: p.customer_product_discount_id,
      has_options: false
    }));

    return {
      products: [...productsWithOptions, ...productsWithoutOptions],
      productsWithOptions,
      productsWithoutOptions
    };
  }

  async setCustomerProductOptionDiscounts(customerId: number, discounts: any[]): Promise<any> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Separate option-level and product-level discounts
      const optionDiscounts = discounts.filter(d => d.option_value_id !== undefined && d.option_value_id !== null);
      const productDiscounts = discounts.filter(d => d.option_value_id === undefined || d.option_value_id === null);

      // Delete existing option-level discounts
      await queryRunner.query('DELETE FROM customer_product_option_discount WHERE customer_id = $1', [customerId]);

      // Delete existing product-level discounts
      await queryRunner.query('DELETE FROM customer_product_discount WHERE customer_id = $1', [customerId]);

      // Insert new option-level discounts
      for (const discount of optionDiscounts) {
        if (discount.discount_percentage > 0) {
          await queryRunner.query(
            `INSERT INTO customer_product_option_discount (customer_id, product_id, option_value_id, discount_percentage)
             VALUES ($1, $2, $3, $4)`,
            [customerId, discount.product_id, discount.option_value_id, discount.discount_percentage],
          );
        }
      }

      // Insert new product-level discounts
      for (const discount of productDiscounts) {
        if (discount.discount_percentage > 0) {
          await queryRunner.query(
            `INSERT INTO customer_product_discount (customer_id, product_id, discount_percentage)
             VALUES ($1, $2, $3)
             ON CONFLICT (customer_id, product_id) 
             DO UPDATE SET discount_percentage = EXCLUDED.discount_percentage, updated_at = CURRENT_TIMESTAMP`,
            [customerId, discount.product_id, discount.discount_percentage],
          );
        }
      }

      await queryRunner.commitTransaction();
      return { message: 'Product and option discounts updated successfully' };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async getCustomerProductOptionDiscount(
    customerId: number,
    productId: number,
    optionValueId: number,
  ): Promise<any> {
    const result = await this.dataSource.query(
      `SELECT * FROM customer_product_option_discount 
       WHERE customer_id = $1 AND product_id = $2 AND option_value_id = $3`,
      [customerId, productId, optionValueId],
    );
    return { discount: result[0] || null };
  }

  /**
   * Get pending approval customers (wholesale from frontend)
   */
  async getPendingApprovalCustomers(query: any): Promise<any> {
    const { limit = 20, offset = 0, search } = query;

    // Check if created_from and approved columns exist
    const createdFromCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'customer' 
      AND column_name IN ('created_from', 'approved')
    `);
    const hasCreatedFrom = createdFromCheck.some((row: any) => row.column_name === 'created_from');
    const hasApproved = createdFromCheck.some((row: any) => row.column_name === 'approved');

    if (!hasCreatedFrom || !hasApproved) {
      return { customers: [], total: 0 };
    }

    let sqlQuery = `
      SELECT 
        c.*,
        co.company_name,
        u.email as user_email,
        u.username as user_username
      FROM customer c
      LEFT JOIN company co ON c.company_id = co.company_id
      LEFT JOIN "user" u ON c.user_id = u.user_id
      WHERE c.created_from = 'storefront' 
        AND COALESCE(c.approved, false) = false
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      sqlQuery += ` AND (c.firstname ILIKE $${paramIndex} OR c.lastname ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR co.company_name ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    sqlQuery += ' ORDER BY c.firstname ASC, c.lastname ASC';
    sqlQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const customers = await this.dataSource.query(sqlQuery, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) as total
      FROM customer c
      WHERE c.created_from = 'storefront' 
        AND COALESCE(c.approved, false) = false
    `;
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (search) {
      countQuery += ` AND (c.firstname ILIKE $${countParamIndex} OR c.lastname ILIKE $${countParamIndex} OR c.email ILIKE $${countParamIndex} OR EXISTS (
        SELECT 1 FROM company co WHERE co.company_id = c.company_id AND co.company_name ILIKE $${countParamIndex}
      ))`;
      countParams.push(`%${search}%`);
      countParamIndex++;
    }

    const countResult = await this.dataSource.query(countQuery, countParams);
    const total = parseInt(countResult[0]?.total || '0', 10);

    // For each customer with a company, find similar existing companies
    const enrichedCustomers = await Promise.all(
      customers.map(async (customer: any) => {
        if (!customer.company_name) return { ...customer, has_similar_company: false, similar_companies: [] };

        // Find companies with similar names (using trigram similarity or ILIKE)
        const similarQuery = `
          SELECT company_id, company_name 
          FROM company 
          WHERE company_id != $1
            AND company_status = 1
            AND (
              company_name ILIKE $2
              OR company_name ILIKE $3
              OR LOWER(company_name) = LOWER($4)
            )
          ORDER BY company_name ASC
          LIMIT 10
        `;
        const name = customer.company_name.trim();
        const similarCompanies = await this.dataSource.query(similarQuery, [
          customer.company_id || 0,
          `%${name}%`,
          `${name.substring(0, Math.max(3, Math.floor(name.length * 0.6)))}%`,
          name,
        ]);

        return {
          ...customer,
          has_similar_company: similarCompanies.length > 0,
          similar_companies: similarCompanies,
        };
      })
    );

    return { customers: enrichedCustomers, total };
  }

  /**
   * Map a pending customer to an existing company or approve their submitted company
   */
  async mapCompanyToCustomer(customerId: number, body: { company_id?: number; approve_new?: boolean }): Promise<any> {
    const customer = await this.dataSource.query(
      `SELECT c.*, co.company_name FROM customer c LEFT JOIN company co ON c.company_id = co.company_id WHERE c.customer_id = $1`,
      [customerId],
    );

    if (!customer || customer.length === 0) {
      throw new NotFoundException('Customer not found');
    }

    const cust = customer[0];

    if (body.company_id) {
      // Map to existing company - update customer's company_id
      const existingCompany = await this.dataSource.query(
        `SELECT company_id, company_name FROM company WHERE company_id = $1`,
        [body.company_id],
      );

      if (!existingCompany || existingCompany.length === 0) {
        throw new BadRequestException('Selected company not found');
      }

      // If customer had a newly created company from registration, delete it (if no other customers use it)
      if (cust.company_id && cust.company_id !== body.company_id) {
        const otherCustomers = await this.dataSource.query(
          `SELECT COUNT(*) as count FROM customer WHERE company_id = $1 AND customer_id != $2`,
          [cust.company_id, customerId],
        );
        if (parseInt(otherCustomers[0]?.count || '0', 10) === 0) {
          // No other customers use this company, safe to delete
          await this.dataSource.query(`DELETE FROM company WHERE company_id = $1`, [cust.company_id]);
        }
      }

      // Update customer to use the existing company
      await this.dataSource.query(
        `UPDATE customer SET company_id = $1 WHERE customer_id = $2`,
        [body.company_id, customerId],
      );

      return { success: true, message: `Customer mapped to company: ${existingCompany[0].company_name}` };
    } else if (body.approve_new) {
      // Approve the company submitted by customer (keep as is - company already created during registration)
      return { success: true, message: `Company "${cust.company_name}" approved as new company` };
    } else {
      throw new BadRequestException('Either company_id or approve_new must be provided');
    }
  }

  /**
   * Approve customer (for wholesale customers from frontend)
   */
  async approveCustomer(id: number): Promise<any> {
    // Get customer details
    const customer = await this.findOne(id);
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    // Check if approved column exists
    const approvedCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'customer' 
      AND column_name = 'approved'
    `);
    const hasApproved = approvedCheck.some((row: any) => row.column_name === 'approved');

    if (!hasApproved) {
      throw new BadRequestException('Approval feature not available');
    }

    // Update customer approval status
    const updateQuery = `
      UPDATE customer 
      SET approved = true 
      WHERE customer_id = $1
      RETURNING *
    `;
    const result = await this.dataSource.query(updateQuery, [id]);

    // Send approval email
    try {
      await this.sendApprovalEmail(customer.customer);
    } catch (error) {
      this.logger.error('Failed to send approval email:', error);
      // Don't fail the approval if email fails
    }

    return { customer: result[0], message: 'Customer approved successfully' };
  }

  /**
   * Reject customer (for wholesale customers from frontend)
   */
  async rejectCustomer(id: number): Promise<any> {
    // Get customer details
    const customer = await this.findOne(id);
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    // Check if approved column exists
    const approvedCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'customer' 
      AND column_name = 'approved'
    `);
    const hasApproved = approvedCheck.some((row: any) => row.column_name === 'approved');

    if (!hasApproved) {
      throw new BadRequestException('Approval feature not available');
    }

    // Update customer approval status to false
    const updateQuery = `
      UPDATE customer 
      SET approved = false 
      WHERE customer_id = $1
      RETURNING *
    `;
    const result = await this.dataSource.query(updateQuery, [id]);

    return { customer: result[0], message: 'Customer rejected successfully' };
  }

  /**
   * Send approval email to customer
   */
  private async sendApprovalEmail(customer: any): Promise<void> {
    const customerEmail = customer.user_email || customer.email;
    if (!customerEmail) {
      this.logger.warn('No email found for customer:', customer.customer_id);
      return;
    }

    const customerName = customer.firstname && customer.lastname
      ? `${customer.firstname} ${customer.lastname}`
      : customer.firstname || customer.user_username || 'Customer';

    const companyName = this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee';
    const contactNumber = this.configService.get<string>('COMPANY_PHONE') || '';
    const contactEmail = this.configService.get<string>('COMPANY_EMAIL') || '';
    const storefrontBase =
      this.configService.get<string>('STOREFRONT_URL') ||
      this.configService.get<string>('FRONTEND_URL') ||
      'http://localhost:3000';
    const storefrontUrl = storefrontBase.replace(/\/$/, '');
    const loginLink = `${storefrontUrl}/auth/login`;

    const wholesaleTypeRaw = (customer.wholesale_type || customer.customer_type || '').toString().toLowerCase();
    const isPremium = wholesaleTypeRaw.includes('premium');

    const templateKey = isPremium
      ? 'wholesale_premium_approved'
      : 'wholesale_essential_approved';

    const subject = isPremium
      ? `Your Wholesale Premium Account Has Been Approved – ${companyName}`
      : `Your Wholesale Essential Account Has Been Approved – ${companyName}`;

    const bodyHtml = isPremium
      ? `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; }
    .header { background-color: #2952E6; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>${companyName}</h1></div>
    <div class="content">
      <p>Dear ${customerName},</p>
      <p>We’re pleased to let you know that your **Wholesale Premium** account has been approved by the store manager.</p>
      <p>You can now log in to your ${companyName} account, access premium wholesale pricing, and place orders online.</p>
      <p>Login here: <a href="${loginLink}">${loginLink}</a></p>
      <p>If you have any questions, please contact us at ${contactNumber} or ${contactEmail}.</p>
      <p>Kind regards,<br/>${companyName} Team</p>
    </div>
  </div>
</body>
</html>`
      : `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; }
    .header { background-color: #2952E6; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>${companyName}</h1></div>
    <div class="content">
      <p>Dear ${customerName},</p>
      <p>We’re pleased to let you know that your **Wholesale Essential** account has been approved by the store manager.</p>
      <p>You can now log in to your ${companyName} account, access wholesale pricing, and place orders online.</p>
      <p>Login here: <a href="${loginLink}">${loginLink}</a></p>
      <p>If you have any questions, please contact us at ${contactNumber} or ${contactEmail}.</p>
      <p>Kind regards,<br/>${companyName} Team</p>
    </div>
  </div>
</body>
</html>`;

    await this.notificationService.sendNotification({
      templateKey,
      recipientEmail: customerEmail,
      recipientName: customerName,
      variables: {
        customer_name: customerName,
        login_link: loginLink,
        contact_number: contactNumber,
        contact_email: contactEmail,
        company_name: companyName,
      },
      customSubject: subject,
      customBody: bodyHtml,
    });

    this.logger.log(`Approval email sent to ${customerEmail}`);
  }
}
