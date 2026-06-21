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
import { AdminCustomersService } from './admin-customers.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../../auth/guards/admin.guard';

@ApiTags('Admin Customers')
@Controller('admin/customers')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class AdminCustomersController {
  constructor(private adminCustomersService: AdminCustomersService) {}

  @Get('wholesale')
  @ApiOperation({ summary: 'Get wholesale customers' })
  async getWholesaleCustomers(@Query() query: any) {
    return this.adminCustomersService.getWholesaleCustomers(query);
  }

  @Get('pending-approval')
  @ApiOperation({ summary: 'Get pending approval customers (wholesale from frontend)' })
  async getPendingApprovalCustomers(@Query() query: any) {
    return this.adminCustomersService.getPendingApprovalCustomers(query);
  }

  @Post(':id/map-company')
  @ApiOperation({ summary: 'Map a pending customer to an existing company or approve their new company' })
  async mapCompany(@Param('id', ParseIntPipe) id: number, @Body() body: { company_id?: number; approve_new?: boolean }) {
    return this.adminCustomersService.mapCompanyToCustomer(id, body);
  }

  @Get()
  @ApiOperation({ summary: 'List all customers' })
  async findAll(@Query() query: any) {
    return this.adminCustomersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get customer by ID' })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.adminCustomersService.findOne(id);
  }

  @Get(':id/product-option-discounts')
  @ApiOperation({ summary: 'Get customer product option discounts' })
  async getCustomerProductOptionDiscounts(@Param('id', ParseIntPipe) id: number) {
    return this.adminCustomersService.getCustomerProductOptionDiscounts(id);
  }

  @Post(':id/product-option-discounts')
  @ApiOperation({ summary: 'Set customer product option discounts' })
  async setCustomerProductOptionDiscounts(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { discounts: any[] },
  ) {
    return this.adminCustomersService.setCustomerProductOptionDiscounts(id, body.discounts);
  }

  @Get(':id/product-option-discounts/:product_id/:option_value_id')
  @ApiOperation({ summary: 'Get specific customer product option discount' })
  async getCustomerProductOptionDiscount(
    @Param('id', ParseIntPipe) customerId: number,
    @Param('product_id', ParseIntPipe) productId: number,
    @Param('option_value_id', ParseIntPipe) optionValueId: number,
  ) {
    return this.adminCustomersService.getCustomerProductOptionDiscount(customerId, productId, optionValueId);
  }

  @Post()
  @ApiOperation({ summary: 'Create new customer' })
  async create(@Body() createCustomerDto: any) {
    return this.adminCustomersService.create(createCustomerDto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update customer' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() updateCustomerDto: any) {
    return this.adminCustomersService.update(id, updateCustomerDto);
  }

  @Post(':id/archive')
  @ApiOperation({ summary: 'Archive customer' })
  async archive(@Param('id', ParseIntPipe) id: number) {
    await this.adminCustomersService.archive(id);
    return { message: 'Customer archived successfully' };
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore customer' })
  async restore(@Param('id', ParseIntPipe) id: number) {
    await this.adminCustomersService.restore(id);
    return { message: 'Customer restored successfully' };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete customer' })
  async delete(@Param('id', ParseIntPipe) id: number) {
    await this.adminCustomersService.delete(id);
    return { message: 'Customer deleted successfully' };
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve customer (for wholesale customers from frontend)' })
  async approveCustomer(@Param('id', ParseIntPipe) id: number) {
    return this.adminCustomersService.approveCustomer(id);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject customer (for wholesale customers from frontend)' })
  async rejectCustomer(@Param('id', ParseIntPipe) id: number) {
    return this.adminCustomersService.rejectCustomer(id);
  }
}
