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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AdminCompaniesService } from './admin-companies.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../../auth/guards/admin.guard';

@ApiTags('Admin Companies')
@Controller('admin/companies')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class AdminCompaniesController {
  constructor(private adminCompaniesService: AdminCompaniesService) {}

  @Get()
  @ApiOperation({ summary: 'List all companies' })
  async findAll(@Query() query: any) {
    return this.adminCompaniesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get company by ID' })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.adminCompaniesService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create new company' })
  async create(@Body() createCompanyDto: any) {
    return this.adminCompaniesService.create(createCompanyDto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update company' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() updateCompanyDto: any) {
    return this.adminCompaniesService.update(id, updateCompanyDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete company' })
  async delete(@Param('id', ParseIntPipe) id: number) {
    await this.adminCompaniesService.delete(id);
    return { message: 'Company deleted successfully' };
  }

  // Company-level pricing (discounts)
  @Get(':id/product-option-discounts')
  @ApiOperation({ summary: 'Get company product and option discounts' })
  async getProductOptionDiscounts(@Param('id', ParseIntPipe) id: number) {
    return this.adminCompaniesService.getCompanyProductOptionDiscounts(id);
  }

  @Post(':id/product-option-discounts')
  @ApiOperation({ summary: 'Set company product and option discounts' })
  async setProductOptionDiscounts(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { discounts: any[] },
  ) {
    return this.adminCompaniesService.setCompanyProductOptionDiscounts(id, body?.discounts || []);
  }

  // Department endpoints
  @Get('departments/list')
  @ApiOperation({ summary: 'List all departments' })
  async listDepartments(@Query('company_id') company_id?: number) {
    return this.adminCompaniesService.listDepartments(company_id);
  }

  @Post('departments')
  @ApiOperation({ summary: 'Create department' })
  async createDepartment(@Body() createDepartmentDto: any) {
    return this.adminCompaniesService.createDepartment(createDepartmentDto);
  }

  @Put('departments/:id')
  @ApiOperation({ summary: 'Update department' })
  async updateDepartment(@Param('id', ParseIntPipe) id: number, @Body() updateDepartmentDto: any) {
    return this.adminCompaniesService.updateDepartment(id, updateDepartmentDto);
  }
}
