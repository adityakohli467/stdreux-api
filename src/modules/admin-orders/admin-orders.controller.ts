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
  Request,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiParam, ApiBody } from '@nestjs/swagger';
import { AdminOrdersService } from './admin-orders.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../../auth/guards/admin.guard';

@ApiTags('Admin Orders')
@Controller('admin/orders')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class AdminOrdersController {
  constructor(private adminOrdersService: AdminOrdersService) { }

  @Get('stats')
  @ApiOperation({ summary: 'Get order statistics' })
  async getStats() {
    return this.adminOrdersService.getStats();
  }

  @Post('fix-totals')
  @ApiOperation({ summary: 'Recalculate and fix order_product.total for all orders with incorrect totals' })
  async fixTotals() {
    return this.adminOrdersService.fixOrderProductTotals();
  }

  @Get('st-druex')
  @ApiOperation({ summary: 'Get St Druex orders' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: Number })
  async getStDruexOrders(@Query() query: any) {
    return this.adminOrdersService.getStDruexOrders(query);
  }

  @Get('wholesale')
  @ApiOperation({ summary: 'Get wholesale orders' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: Number })
  async getWholesaleOrders(@Query() query: any) {
    return this.adminOrdersService.findAll({ ...query, wholesale: 'true' });
  }

  @Get()
  @ApiOperation({ summary: 'List all orders' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: Number })
  @ApiQuery({ name: 'customer_id', required: false, type: Number })
  @ApiQuery({ name: 'wholesale', required: false, type: String })
  async findAll(@Query() query: any) {
    return this.adminOrdersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get order by ID' })
  @ApiParam({ name: 'id', type: Number })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.adminOrdersService.findOne(id);
  }

  @Get(':id/checklist')
  @ApiOperation({ summary: 'Get order checklist' })
  @ApiParam({ name: 'id', type: Number })
  async getChecklist(@Param('id', ParseIntPipe) id: number) {
    // TODO: Implement checklist logic
    return { message: 'Checklist endpoint - to be implemented' };
  }

  @Post()
  @ApiOperation({ summary: 'Create new order' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'number' },
        order_items: { type: 'array', items: { type: 'object' } },
        delivery_address: { type: 'string' },
        delivery_date: { type: 'string' },
        delivery_time: { type: 'string' },
        order_status: { type: 'number' },
        payment_status: { type: 'string' },
        total_amount: { type: 'number' },
        notes: { type: 'string' },
      },
    },
  })
  async create(@Body() createOrderDto: any, @Request() req: any) {
    const userId = req.user?.user_id || 1; // Default to 1 if no user found
    return this.adminOrdersService.create(createOrderDto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update order' })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'number' },
        order_items: { type: 'array', items: { type: 'object' } },
        delivery_address: { type: 'string' },
        delivery_date: { type: 'string' },
        delivery_time: { type: 'string' },
        order_status: { type: 'number' },
        payment_status: { type: 'string' },
        total_amount: { type: 'number' },
        notes: { type: 'string' },
      },
    },
  })
  async update(@Param('id', ParseIntPipe) id: number, @Body() updateOrderDto: any, @Request() req: any) {
    const userId = req.user?.user_id || req.user?.id;
    return this.adminOrdersService.update(id, updateOrderDto, userId);
  }

  @Put(':id/status')
  @ApiOperation({ summary: 'Update order status' })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        order_status: { type: 'number', example: 1 },
        comment: { type: 'string' },
      },
      required: ['order_status'],
    },
  })
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { order_status: number; comment?: string },
  ) {
    return this.adminOrdersService.updateStatus(id, body.order_status, body.comment);
  }

  @Put(':id/notes')
  @ApiOperation({ summary: 'Update order notes and weight' })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        notes: { type: 'string' },
        weight: { type: 'number' },
      },
      required: ['notes'],
    },
  })
  async updateNotes(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { notes: string; weight?: number },
  ) {
    return this.adminOrdersService.updateOrderNotes(id, body.notes, body.weight);
  }

  @Put(':id/complete')
  @ApiOperation({ summary: 'Complete order' })
  @ApiParam({ name: 'id', type: Number })
  async complete(@Param('id', ParseIntPipe) id: number) {
    return this.adminOrdersService.markAsCompleted(id);
  }

  @Put(':id/packaging-status')
  @ApiOperation({ summary: 'Update order packaging status' })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        packaging_status: { type: 'number', example: 1, description: '0=New Order, 1=Printed, 2=Packed, 3=Delivered' },
      },
      required: ['packaging_status'],
    },
  })
  async updatePackagingStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { packaging_status: number },
  ) {
    return this.adminOrdersService.updatePackagingStatus(id, body.packaging_status);
  }

  @Put(':id/packaging-comment')
  @ApiOperation({ summary: 'Update order packaging comment' })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        packaging_comment: { type: 'string', description: 'Packaging slip comment' },
      },
      required: ['packaging_comment'],
    },
  })
  async updatePackagingComment(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { packaging_comment: string },
  ) {
    return this.adminOrdersService.updatePackagingComment(id, body.packaging_comment);
  }

  @Put(':id/mark-paid')
  @ApiOperation({ summary: 'Mark order as paid' })
  @ApiParam({ name: 'id', type: Number })
  async markPaid(@Param('id', ParseIntPipe) id: number, @Body() body: { comment?: string }, @Request() req: any) {
    const userId = req.user?.user_id || req.user?.id;
    return this.adminOrdersService.markAsPaid(id, userId, body?.comment);
  }


  @Put(':id/products/:productId/prepared')
  @ApiOperation({ summary: 'Update product prepared status' })
  @ApiParam({ name: 'id', type: Number })
  @ApiParam({ name: 'productId', type: Number })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        is_prepared: { type: 'boolean' },
      },
      required: ['is_prepared'],
    },
  })
  async updatePrepared(
    @Param('id', ParseIntPipe) id: number,
    @Param('productId', ParseIntPipe) productId: number,
    @Body() body: { is_prepared: boolean },
  ) {
    // TODO: Implement prepared status update
    return { message: 'Prepared status update - to be implemented' };
  }

  @Put(':id/checklist')
  @ApiOperation({ summary: 'Update order checklist' })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        checklist: { type: 'array', items: { type: 'object' } },
      },
    },
  })
  async updateChecklist(@Param('id', ParseIntPipe) id: number, @Body() checklist: any) {
    // TODO: Implement checklist update
    return { message: 'Checklist update - to be implemented' };
  }

  @Post(':id/send-email')
  @ApiOperation({ summary: 'Send order email to customer' })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        email_type: { type: 'string' },
        custom_message: { type: 'string' },
        recipient_email: { type: 'string' },
      },
    },
  })
  async sendEmail(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { email_type?: string; custom_message?: string; recipient_email?: string },
  ) {
    return this.adminOrdersService.sendEmail(id, body.email_type, body.custom_message, body.recipient_email);
  }

  @Post(':id/send-payment-link')
  @ApiOperation({ summary: 'Send payment link to customer' })
  @ApiParam({ name: 'id', type: Number })
  async sendPaymentLink(@Param('id', ParseIntPipe) id: number) {
    return this.adminOrdersService.sendPaymentLink(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete order' })
  @ApiParam({ name: 'id', type: Number })
  async delete(@Param('id', ParseIntPipe) id: number) {
    await this.adminOrdersService.delete(id);
    return { message: 'Order deleted successfully' };
  }
}
