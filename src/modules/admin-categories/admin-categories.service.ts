import { Injectable, Logger, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class AdminCategoriesService implements OnModuleInit {
  private readonly logger = new Logger(AdminCategoriesService.name);

  constructor(private dataSource: DataSource) {}

  async onModuleInit() {
    try {
      await this.dataSource.query(`
        ALTER TABLE category
        ADD COLUMN IF NOT EXISTS gst_free BOOLEAN DEFAULT FALSE
      `);
      this.logger.log('Ensured gst_free column exists in category table');
    } catch (error) {
      this.logger.error('Failed to add gst_free column to category table:', error);
    }
  }

  async findAll(query: any): Promise<any> {
    const { limit = 20, offset = 0, search } = query;

    let sqlQuery = `
      SELECT 
        c.*,
        pc.category_name as parent_category_name
      FROM category c
      LEFT JOIN category pc ON c.parent_category_id = pc.category_id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      sqlQuery += ` AND c.category_name ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    sqlQuery += ' ORDER BY c.parent_category_id NULLS FIRST, COALESCE(c.sort_order, 999999), c.category_name';
    sqlQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await this.dataSource.query(sqlQuery, params);

    let countQuery = 'SELECT COUNT(*) FROM category c WHERE 1=1';
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (search) {
      countQuery += ` AND c.category_name ILIKE $${countParamIndex}`;
      countParams.push(`%${search}%`);
    }

    const countResult = await this.dataSource.query(countQuery, countParams);
    const count = parseInt(countResult[0].count);

    return { categories: result, count, limit: Number(limit), offset: Number(offset) };
  }

  async findOne(id: number): Promise<any> {
    const result = await this.dataSource.query(
      `SELECT 
        c.*,
        pc.category_name as parent_category_name
      FROM category c
      LEFT JOIN category pc ON c.parent_category_id = pc.category_id
      WHERE c.category_id = $1`,
      [id],
    );

    if (result.length === 0) {
      throw new NotFoundException('Category not found');
    }

    return { category: result[0] };
  }

  async create(createCategoryDto: any): Promise<any> {
    const { category_name } = createCategoryDto;
    const parent_category_id = createCategoryDto.parent_category_id ?? createCategoryDto.parent_id ?? null;
    const sort_order = createCategoryDto.sort_order ?? null;
    const status = createCategoryDto.status ?? null;
    const category_description = createCategoryDto.category_description ?? null;

    if (!category_name) {
      throw new BadRequestException('Category name is required');
    }

    const columns: string[] = ['category_name', 'parent_category_id'];
    const values: any[] = [category_name, parent_category_id];
    const placeholders: string[] = ['$1', '$2'];
    let idx = 3;
    if (category_description !== null && category_description !== undefined) {
      columns.push('category_description');
      values.push(category_description);
      placeholders.push(`$${idx++}`);
    }
    if (status !== null && status !== undefined) {
      columns.push('status');
      values.push(status);
      placeholders.push(`$${idx++}`);
    }
    if (sort_order !== null && sort_order !== undefined) {
      columns.push('sort_order');
      values.push(sort_order);
      placeholders.push(`$${idx++}`);
    }
    if (createCategoryDto.gst_free !== null && createCategoryDto.gst_free !== undefined) {
      columns.push('gst_free');
      values.push(createCategoryDto.gst_free ? true : false);
      placeholders.push(`$${idx++}`);
    }

    const result = await this.dataSource.query(
      `INSERT INTO category (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values,
    );

    return { category: result[0], message: 'Category created successfully' };
  }

  async update(id: number, updateCategoryDto: any): Promise<any> {
    const category_name = updateCategoryDto.category_name ?? null;
    const parent_category_id = updateCategoryDto.parent_category_id ?? updateCategoryDto.parent_id ?? null;
    const sort_order = updateCategoryDto.sort_order ?? null;
    const status = updateCategoryDto.status ?? null;
    const category_description = updateCategoryDto.category_description ?? null;

    const sets: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (category_name !== null && category_name !== undefined) {
      sets.push(`category_name = $${p++}`);
      params.push(category_name);
    }
    if (parent_category_id !== null && parent_category_id !== undefined) {
      sets.push(`parent_category_id = $${p++}`);
      params.push(parent_category_id);
    }
    if (category_description !== null && category_description !== undefined) {
      sets.push(`category_description = $${p++}`);
      params.push(category_description);
    }
    if (status !== null && status !== undefined) {
      sets.push(`status = $${p++}`);
      params.push(status);
    }
    if (sort_order !== null && sort_order !== undefined) {
      sets.push(`sort_order = $${p++}`);
      params.push(sort_order);
    }
    if (updateCategoryDto.gst_free !== null && updateCategoryDto.gst_free !== undefined) {
      sets.push(`gst_free = $${p++}`);
      params.push(updateCategoryDto.gst_free ? true : false);
    }
    if (sets.length === 0) {
      throw new BadRequestException('No fields to update');
    }
    params.push(id);

    const result = await this.dataSource.query(
      `UPDATE category SET ${sets.join(', ')} WHERE category_id = $${p} RETURNING *`,
      params,
    );

    if (result.length === 0) {
      throw new NotFoundException('Category not found');
    }

    return { category: result[0], message: 'Category updated successfully' };
  }

  async delete(id: number): Promise<void> {
    const result = await this.dataSource.query('DELETE FROM category WHERE category_id = $1 RETURNING *', [id]);

    if (result.length === 0) {
      throw new NotFoundException('Category not found');
    }
  }

  async reorder(categoryIds: number[]): Promise<any> {
    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
      throw new BadRequestException('Invalid category IDs');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      for (let i = 0; i < categoryIds.length; i++) {
        await queryRunner.query('UPDATE category SET sort_order = $1 WHERE category_id = $2', [i, categoryIds[i]]);
      }
      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }

    return { message: 'Categories reordered successfully' };
  }
}
