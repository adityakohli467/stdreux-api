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

    const { company_name, company_abn, company_phone, company_address, company_status } = createCompanyDto;

    if (!company_name || (typeof company_name === 'string' && !company_name.trim())) {
      throw new BadRequestException('Company name is required');
    }

    try {
      const result = await this.dataSource.query(
        `INSERT INTO company (company_name, company_abn, company_phone, company_address, company_status, company_created_on) 
         VALUES ($1, $2, $3, $4, $5, NOW()) 
         RETURNING *`,
        [company_name, company_abn || null, company_phone, company_address || null, company_status || 1],
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
    const { company_name, company_abn, company_phone, company_address, company_status } = updateCompanyDto;

    const result = await this.dataSource.query(
      `UPDATE company 
       SET company_name = $1, company_abn = $2, company_phone = $3, company_address = $4, company_status = COALESCE($5, company_status)
       WHERE company_id = $6
       RETURNING *`,
      [company_name, company_abn || null, company_phone, company_address || null, company_status, id],
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
}
