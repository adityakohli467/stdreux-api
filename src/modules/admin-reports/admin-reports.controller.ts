import {
  Controller,
  Get,
  Query,
  UseGuards,
  Res,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { AdminReportsService } from './admin-reports.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../../auth/guards/admin.guard';

@ApiTags('Admin Reports')
@Controller('admin/reports')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class AdminReportsController {
  constructor(private readonly adminReportsService: AdminReportsService) {}

  @Get()
  @ApiOperation({ summary: 'List reports with filters' })
  @ApiQuery({ name: 'order_date_from', required: false, type: String })
  @ApiQuery({ name: 'order_date_to', required: false, type: String })
  @ApiQuery({ name: 'delivery_date_from', required: false, type: String })
  @ApiQuery({ name: 'delivery_date_to', required: false, type: String })
  @ApiQuery({ name: 'location_id', required: false, type: Number })
  @ApiQuery({ name: 'company', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'payment_status', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async listReports(
    @Query('order_date_from') orderDateFrom?: string,
    @Query('order_date_to') orderDateTo?: string,
    @Query('delivery_date_from') deliveryDateFrom?: string,
    @Query('delivery_date_to') deliveryDateTo?: string,
    @Query('location_id') locationId?: string,
    @Query('company') company?: string,
    @Query('status') status?: string,
    @Query('payment_status') paymentStatus?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.adminReportsService.listReports({
      order_date_from: orderDateFrom,
      order_date_to: orderDateTo,
      delivery_date_from: deliveryDateFrom,
      delivery_date_to: deliveryDateTo,
      location_id: locationId ? parseInt(locationId) : undefined,
      company,
      status,
      payment_status: paymentStatus,
      search,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
    });
  }

  @Get('download/csv')
  @ApiOperation({ summary: 'Download CSV report' })
  @ApiQuery({ name: 'order_date_from', required: false, type: String })
  @ApiQuery({ name: 'order_date_to', required: false, type: String })
  @ApiQuery({ name: 'delivery_date_from', required: false, type: String })
  @ApiQuery({ name: 'delivery_date_to', required: false, type: String })
  @ApiQuery({ name: 'location_id', required: false, type: Number })
  @ApiQuery({ name: 'company', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'payment_status', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  async downloadCSV(
    @Res() res: Response,
    @Query('order_date_from') orderDateFrom?: string,
    @Query('order_date_to') orderDateTo?: string,
    @Query('delivery_date_from') deliveryDateFrom?: string,
    @Query('delivery_date_to') deliveryDateTo?: string,
    @Query('location_id') locationId?: string,
    @Query('company') company?: string,
    @Query('status') status?: string,
    @Query('payment_status') paymentStatus?: string,
    @Query('search') search?: string,
  ) {
    const csv = await this.adminReportsService.downloadCSV({
      order_date_from: orderDateFrom,
      order_date_to: orderDateTo,
      delivery_date_from: deliveryDateFrom,
      delivery_date_to: deliveryDateTo,
      location_id: locationId ? parseInt(locationId) : undefined,
      company,
      status,
      payment_status: paymentStatus,
      search,
    });

    res.header('Content-Type', 'text/csv');
    res.attachment('orders_report.csv');
    res.send(csv);
  }
}
