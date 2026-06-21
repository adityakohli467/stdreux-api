import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  UseInterceptors,
  UploadedFiles,
  Request,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody, ApiQuery, ApiParam } from '@nestjs/swagger';
import { AdminProductsService } from './admin-products.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../../auth/guards/admin.guard';

@ApiTags('Admin Products')
@Controller(['admin/products', 'admin/products-new']) // Support both routes for backward compatibility
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class AdminProductsController {
  constructor(private readonly adminProductsService: AdminProductsService) { }

  @Get()
  @ApiOperation({ summary: 'List products with search and pagination' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: Number })
  @ApiQuery({ name: 'customer_id', required: false, type: Number, description: 'Optional: Calculate prices based on customer type and discounts' })
  @ApiQuery({ name: 'company_id', required: false, type: Number, description: 'Optional: Apply company-level pricing (overrides customer pricing)' })
  async listProducts(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('customer_id') customer_id?: string,
    @Query('company_id') company_id?: string,
  ) {
    return this.adminProductsService.listProducts({
      limit: limit ? parseInt(limit) : 20,
      offset: offset ? parseInt(offset) : 0,
      search,
      status: status ? parseInt(status) : undefined,
      customer_id: customer_id ? parseInt(customer_id) : undefined,
      company_id: company_id ? parseInt(company_id) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single product' })
  @ApiParam({ name: 'id', type: Number })
  @ApiQuery({ name: 'customer_id', required: false, type: Number, description: 'Optional: Calculate prices based on customer type and discounts' })
  @ApiQuery({ name: 'company_id', required: false, type: Number, description: 'Optional: Apply company-level pricing (overrides customer pricing)' })
  async getProduct(
    @Param('id', ParseIntPipe) id: number,
    @Query('customer_id') customer_id?: string,
    @Query('company_id') company_id?: string,
  ) {
    return this.adminProductsService.getProduct(id, customer_id ? parseInt(customer_id) : undefined, company_id ? parseInt(company_id) : undefined);
  }

  @Post()
  @ApiOperation({ summary: 'Create product' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FilesInterceptor('images', 10))
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string' },
        product_description: { type: 'string' },
        product_price: { type: 'number' },
        retail_price: { type: 'number' },
        retail_discount_percentage: { type: 'number' },
        user_price: { type: 'number' },
        customer_type_visibility: { type: 'string' },
        product_status: { type: 'number' },
        user_id: { type: 'number' },
        categories: { type: 'string', description: 'JSON array string' },
        options: { type: 'string', description: 'JSON array string' },
        product_image_url: { type: 'string' },
        product_images: { type: 'string', description: 'JSON array string' },
        images: { type: 'array', items: { type: 'string', format: 'binary' } },
        show_in_store: { type: 'boolean' },
        add_to_subscription: { type: 'boolean' },
      },
    },
  })
  async createProduct(
    @Body() productData: any,
    @UploadedFiles() files?: Express.Multer.File[],
    @Request() req?: any,
  ) {
    // Parse JSON strings if they exist
    const parsedData = {
      ...productData,
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
      product_images: productData.product_images
        ? typeof productData.product_images === 'string'
          ? JSON.parse(productData.product_images)
          : productData.product_images
        : [],
      user_id: productData.user_id || req?.user?.user_id,
    };

    return this.adminProductsService.createProduct(parsedData, files);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update product' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FilesInterceptor('images', 10))
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string' },
        product_description: { type: 'string' },
        product_price: { type: 'number' },
        retail_price: { type: 'number' },
        retail_discount_percentage: { type: 'number' },
        user_price: { type: 'number' },
        customer_type_visibility: { type: 'string' },
        product_status: { type: 'number' },
        categories: { type: 'string', description: 'JSON array string' },
        options: { type: 'string', description: 'JSON array string' },
        product_image_url: { type: 'string' },
        product_images: { type: 'string', description: 'JSON array string' },
        images: { type: 'array', items: { type: 'string', format: 'binary' } },
        show_in_store: { type: 'boolean' },
        add_to_subscription: { type: 'boolean' },
      },
    },
  })
  async updateProduct(
    @Param('id', ParseIntPipe) id: number,
    @Body() productData: any,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    // Parse JSON strings if they exist
    const parsedData = {
      ...productData,
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
      product_images: productData.product_images
        ? typeof productData.product_images === 'string'
          ? JSON.parse(productData.product_images)
          : productData.product_images
        : undefined,
    };

    return this.adminProductsService.updateProduct(id, parsedData, files);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete product' })
  @ApiParam({ name: 'id', type: Number })
  async deleteProduct(@Param('id', ParseIntPipe) id: number) {
    return this.adminProductsService.deleteProduct(id);
  }

  // Category management endpoints
  @Get('categories/list')
  @ApiOperation({ summary: 'List all categories' })
  async listCategories() {
    return this.adminProductsService.listCategories();
  }

  @Post('categories')
  @ApiOperation({ summary: 'Create category' })
  async createCategory(@Body() data: { category_name: string; parent_category_id?: number }) {
    return this.adminProductsService.createCategory(data);
  }

  @Put('categories/:id')
  @ApiOperation({ summary: 'Update category' })
  @ApiParam({ name: 'id', type: Number })
  async updateCategory(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: { category_name?: string; parent_category_id?: number },
  ) {
    return this.adminProductsService.updateCategory(id, data);
  }

  @Delete('categories/:id')
  @ApiOperation({ summary: 'Delete category' })
  @ApiParam({ name: 'id', type: Number })
  async deleteCategory(@Param('id', ParseIntPipe) id: number) {
    return this.adminProductsService.deleteCategory(id);
  }
}
