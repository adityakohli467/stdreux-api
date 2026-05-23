import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FileStorageService } from '../../common/services/file-storage.service';

@Injectable()
export class AdminBlogsService {
  private readonly logger = new Logger(AdminBlogsService.name);

  constructor(
    private dataSource: DataSource,
    private fileStorageService: FileStorageService,
  ) {}

  /**
   * Generate URL-friendly slug from title
   */
  private generateSlug(title: string): string {
    return title
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
      .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
  }

  /**
   * Calculate estimated reading time from content
   */
  private calculateReadTime(content: string): number {
    const wordsPerMinute = 200;
    const text = content.replace(/<[^>]*>/g, ''); // Remove HTML tags
    const wordCount = text.split(/\s+/).filter(word => word.length > 0).length;
    return Math.max(1, Math.ceil(wordCount / wordsPerMinute));
  }

  /**
   * List blogs with search and pagination
   */
  async listBlogs(filters: {
    limit?: number;
    offset?: number;
    search?: string;
    is_published?: boolean;
    category?: string;
  }) {
    const { limit = 20, offset = 0, search, is_published, category } = filters;

    let query = `
      SELECT 
        b.*,
        u.username as created_by_username,
        u.email as created_by_email
      FROM blogs b
      LEFT JOIN "user" u ON b.created_by = u.user_id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    // Search filter
    if (search) {
      query += ` AND (b.title ILIKE $${paramIndex} OR b.excerpt ILIKE $${paramIndex} OR b.content ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Published filter
    if (is_published !== undefined) {
      query += ` AND b.is_published = $${paramIndex}`;
      params.push(is_published);
      paramIndex++;
    }

    // Category filter
    if (category) {
      query += ` AND b.category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    query += ' ORDER BY b.created_date DESC';
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await this.dataSource.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM blogs b WHERE 1=1';
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (search) {
      countQuery += ` AND (b.title ILIKE $${countParamIndex} OR b.excerpt ILIKE $${countParamIndex} OR b.content ILIKE $${countParamIndex})`;
      countParams.push(`%${search}%`);
      countParamIndex++;
    }

    if (is_published !== undefined) {
      countQuery += ` AND b.is_published = $${countParamIndex}`;
      countParams.push(is_published);
      countParamIndex++;
    }

    if (category) {
      countQuery += ` AND b.category = $${countParamIndex}`;
      countParams.push(category);
      countParamIndex++;
    }

    const countResult = await this.dataSource.query(countQuery, countParams);
    const total = parseInt(countResult[0]?.count || '0', 10);

    return {
      blogs: result,
      total,
      limit,
      offset,
    };
  }

  /**
   * Get single blog by ID
   */
  async getBlog(blogId: number) {
    const query = `
      SELECT 
        b.*,
        u.username as created_by_username,
        u.email as created_by_email
      FROM blogs b
      LEFT JOIN "user" u ON b.created_by = u.user_id
      WHERE b.blog_id = $1
    `;

    const result = await this.dataSource.query(query, [blogId]);

    if (result.length === 0) {
      throw new NotFoundException(`Blog with ID ${blogId} not found`);
    }

    return result[0];
  }

  /**
   * Get blog by slug (for storefront)
   */
  async getBlogBySlug(slug: string) {
    const query = `
      SELECT 
        b.*,
        u.username as created_by_username,
        u.email as created_by_email
      FROM blogs b
      LEFT JOIN "user" u ON b.created_by = u.user_id
      WHERE b.slug = $1 AND b.is_published = true
    `;

    const result = await this.dataSource.query(query, [slug]);

    if (result.length === 0) {
      throw new NotFoundException(`Blog with slug ${slug} not found`);
    }

    return result[0];
  }

  /**
   * Create new blog
   */
  async createBlog(data: {
    title: string;
    slug?: string;
    category?: string;
    excerpt?: string;
    content: string;
    featured_image_url?: string;
    author?: string;
    tags?: string[];
    read_time?: number;
    is_featured?: boolean;
    is_published?: boolean;
    published_date?: Date;
    created_by: number;
  }) {
    // Generate slug if not provided
    const slug = data.slug || this.generateSlug(data.title);

    // Check if slug already exists
    const existingBlog = await this.dataSource.query(
      'SELECT blog_id FROM blogs WHERE slug = $1',
      [slug]
    );

    if (existingBlog.length > 0) {
      // Append timestamp to make it unique
      const uniqueSlug = `${slug}-${Date.now()}`;
      data.slug = uniqueSlug;
    } else {
      data.slug = slug;
    }

    // Calculate read time if not provided
    const readTime = data.read_time || this.calculateReadTime(data.content);

    // Set published_date if publishing
    let publishedDate = data.published_date;
    if (data.is_published && !publishedDate) {
      publishedDate = new Date();
    }

    // Ensure the blog_id sequence is in sync with actual data to prevent conflicts
    await this.dataSource.query(
      `SELECT setval(pg_get_serial_sequence('blogs', 'blog_id'), COALESCE((SELECT MAX(blog_id) FROM blogs), 0) + 1, false)`
    );

    const query = `
      INSERT INTO blogs (
        title, slug, category, excerpt, content, featured_image_url,
        author, tags, read_time, is_featured, is_published, published_date, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `;

    const params = [
      data.title,
      data.slug,
      data.category || null,
      data.excerpt || null,
      data.content,
      data.featured_image_url || null,
      data.author || null,
      data.tags || [],
      readTime,
      data.is_featured || false,
      data.is_published || false,
      publishedDate,
      data.created_by,
    ];

    const result = await this.dataSource.query(query, params);
    return result[0];
  }

  /**
   * Update blog
   */
  async updateBlog(blogId: number, data: {
    title?: string;
    slug?: string;
    category?: string;
    excerpt?: string;
    content?: string;
    featured_image_url?: string;
    author?: string;
    tags?: string[];
    read_time?: number;
    is_featured?: boolean;
    is_published?: boolean;
    published_date?: Date;
  }) {
    // Check if blog exists
    const existingBlog = await this.getBlog(blogId);

    // Generate slug if title changed
    let slug = data.slug;
    if (data.title && !slug) {
      slug = this.generateSlug(data.title);
      
      // Check if new slug conflicts with existing blogs
      const conflictCheck = await this.dataSource.query(
        'SELECT blog_id FROM blogs WHERE slug = $1 AND blog_id != $2',
        [slug, blogId]
      );

      if (conflictCheck.length > 0) {
        slug = `${slug}-${Date.now()}`;
      }
    }

    // Calculate read time if content changed
    let readTime = data.read_time;
    if (data.content && !readTime) {
      readTime = this.calculateReadTime(data.content);
    } else if (!readTime) {
      readTime = existingBlog.read_time;
    }

    // Handle publish/unpublish
    let publishedDate = data.published_date;
    if (data.is_published !== undefined) {
      if (data.is_published && !existingBlog.is_published && !publishedDate) {
        // Publishing for the first time
        publishedDate = new Date();
      } else if (!data.is_published) {
        // Unpublishing
        publishedDate = undefined;
      } else if (data.is_published && existingBlog.published_date) {
        // Already published, keep existing date
        publishedDate = existingBlog.published_date;
      }
    }

    const updateFields: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (data.title !== undefined) {
      updateFields.push(`title = $${paramIndex++}`);
      params.push(data.title);
    }
    if (slug !== undefined) {
      updateFields.push(`slug = $${paramIndex++}`);
      params.push(slug);
    }
    if (data.category !== undefined) {
      updateFields.push(`category = $${paramIndex++}`);
      params.push(data.category);
    }
    if (data.excerpt !== undefined) {
      updateFields.push(`excerpt = $${paramIndex++}`);
      params.push(data.excerpt);
    }
    if (data.content !== undefined) {
      updateFields.push(`content = $${paramIndex++}`);
      params.push(data.content);
    }
    if (data.featured_image_url !== undefined) {
      updateFields.push(`featured_image_url = $${paramIndex++}`);
      params.push(data.featured_image_url);
    }
    if (data.author !== undefined) {
      updateFields.push(`author = $${paramIndex++}`);
      params.push(data.author);
    }
    if (data.tags !== undefined) {
      updateFields.push(`tags = $${paramIndex++}`);
      params.push(data.tags);
    }
    if (readTime !== undefined) {
      updateFields.push(`read_time = $${paramIndex++}`);
      params.push(readTime);
    }
    if (data.is_featured !== undefined) {
      updateFields.push(`is_featured = $${paramIndex++}`);
      params.push(data.is_featured);
    }
    if (data.is_published !== undefined) {
      updateFields.push(`is_published = $${paramIndex++}`);
      params.push(data.is_published);
    }
    if (publishedDate !== undefined) {
      updateFields.push(`published_date = $${paramIndex++}`);
      params.push(publishedDate);
    }

    // Always update modified_date
    updateFields.push(`modified_date = CURRENT_TIMESTAMP`);

    if (updateFields.length === 0) {
      return existingBlog;
    }

    params.push(blogId);
    const query = `
      UPDATE blogs
      SET ${updateFields.join(', ')}
      WHERE blog_id = $${paramIndex}
      RETURNING *
    `;

    const result = await this.dataSource.query(query, params);
    return result[0];
  }

  /**
   * Delete blog
   */
  async deleteBlog(blogId: number) {
    const blog = await this.getBlog(blogId);

    // Delete featured image if exists
    if (blog.featured_image_url) {
      try {
        // Extract key from URL
        const key = blog.featured_image_url.includes('/uploads/')
          ? blog.featured_image_url.split('/uploads/')[1]
          : blog.featured_image_url;
        await this.fileStorageService.deleteFile(key);
      } catch (error) {
        this.logger.warn(`Failed to delete image: ${blog.featured_image_url}`, error);
      }
    }

    await this.dataSource.query('DELETE FROM blogs WHERE blog_id = $1', [blogId]);
    return { message: 'Blog deleted successfully' };
  }

  /**
   * Upload featured image
   */
  async uploadFeaturedImage(file: Express.Multer.File): Promise<string> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    try {
      // Clean filename to remove any path separators
      const cleanFileName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      const fileName = `blogs/${Date.now()}-${cleanFileName}`;
      const result = await this.fileStorageService.uploadFile(file.buffer, 'stn_assets', fileName);
      
      // Log the upload result for debugging
      this.logger.log(`Blog image uploaded successfully: ${result.url}`);
      this.logger.log(`Blog image details:`, {
        url: result.url,
        key: result.key,
        fileName: fileName,
      });
      
      // Ensure URL is properly formatted
      if (!result.url || !result.url.startsWith('http')) {
        this.logger.error(`Invalid image URL returned: ${result.url}`);
        throw new BadRequestException('Invalid image URL returned from upload');
      }
      
      return result.url;
    } catch (error) {
      this.logger.error('Failed to upload blog image:', error);
      throw new BadRequestException(`Failed to upload image: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get published blogs for storefront
   */
  async getPublishedBlogs(filters: {
    limit?: number;
    offset?: number;
    category?: string;
    featured?: boolean;
    search?: string;
  }) {
    const { limit = 20, offset = 0, category, featured, search } = filters;

    let query = `
      SELECT 
        blog_id,
        title,
        slug,
        category,
        excerpt,
        featured_image_url,
        author,
        tags,
        read_time,
        is_featured,
        published_date,
        created_date
      FROM blogs
      WHERE is_published = true
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      query += ` AND (title ILIKE $${paramIndex} OR excerpt ILIKE $${paramIndex} OR content ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (category) {
      query += ` AND category = $${paramIndex++}`;
      params.push(category);
    }

    if (featured !== undefined) {
      query += ` AND is_featured = $${paramIndex++}`;
      params.push(featured);
    }

    query += ' ORDER BY published_date DESC, created_date DESC';
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await this.dataSource.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM blogs WHERE is_published = true';
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (search) {
      countQuery += ` AND (title ILIKE $${countParamIndex} OR excerpt ILIKE $${countParamIndex} OR content ILIKE $${countParamIndex})`;
      countParams.push(`%${search}%`);
      countParamIndex++;
    }

    if (category) {
      countQuery += ` AND category = $${countParamIndex++}`;
      countParams.push(category);
    }

    if (featured !== undefined) {
      countQuery += ` AND is_featured = $${countParamIndex++}`;
      countParams.push(featured);
    }

    const countResult = await this.dataSource.query(countQuery, countParams);
    const total = parseInt(countResult[0]?.count || '0', 10);

    return {
      blogs: result,
      total,
      limit,
      offset,
    };
  }

  /**
   * Get blog categories (distinct categories from published blogs)
   */
  async getCategories() {
    const query = `
      SELECT DISTINCT category
      FROM blogs
      WHERE is_published = true AND category IS NOT NULL
      ORDER BY category
    `;

    const result = await this.dataSource.query(query);
    return result.map((row: any) => row.category);
  }
}

