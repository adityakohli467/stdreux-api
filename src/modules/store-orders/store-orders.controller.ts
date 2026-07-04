import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  Res,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { StoreOrdersService } from './store-orders.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AdminUploadService } from '../admin-upload/admin-upload.service';

@ApiTags('Store Orders')
@Controller('store/orders')
export class StoreOrdersController {
  constructor(
    private readonly storeOrdersService: StoreOrdersService,
    private readonly adminUploadService: AdminUploadService,
  ) { }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create order (checkout)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
              quantity: { type: 'number' },
              price: { type: 'number' },
              options: { type: 'array', items: { type: 'object' } },
            },
          },
        },
        delivery_address: { type: 'string', example: '123 Main St' },
        delivery_date_time: { type: 'string', example: '2026-02-27T20:25:00' },
        delivery_date: { type: 'string', example: '2024-01-15' },
        delivery_time: { type: 'string', example: '10:00 AM' },
        delivery_fee: { type: 'number' },
        payment_method: { type: 'string', example: 'card' },
        notes: { type: 'string' },
        coupon_code: { type: 'string' },
        postcode: { type: 'string' },
        telephone: { type: 'string' },
      },
      required: ['items', 'delivery_address'],
    },
  })
  async createOrder(
    @Request() req: any,
    @Body() orderData: {
      items: any[];
      delivery_address: string;
      delivery_date_time?: string;
      delivery_date?: string;
      delivery_time?: string;
      delivery_fee?: number;
      payment_method?: string;
      payment_intent_id?: string;
      notes?: string;
      coupon_code?: string;
      postcode?: string;
      telephone?: string;
    },
  ) {
    const userId = req.user?.user_id;
    if (!userId) {
      throw new Error('Unauthorized');
    }
    return this.storeOrdersService.createOrder(userId, orderData);
  }

  @Post('guest')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create guest order' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
              quantity: { type: 'number' },
              price: { type: 'number' },
              options: { type: 'array', items: { type: 'object' } },
            },
          },
        },
        delivery_address: { type: 'string', example: '123 Main St' },
        delivery_date_time: { type: 'string', example: '2026-02-27T20:25:00' },
        delivery_date: { type: 'string', example: '2024-01-15' },
        delivery_time: { type: 'string', example: '10:00 AM' },
        delivery_fee: { type: 'number' },
        payment_method: { type: 'string', example: 'card' },
        notes: { type: 'string' },
        coupon_code: { type: 'string' },
        postcode: { type: 'string' },
        firstname: { type: 'string' },
        lastname: { type: 'string' },
        email: { type: 'string' },
        telephone: { type: 'string' },
      },
      required: ['items', 'delivery_address', 'email', 'firstname', 'lastname'],
    },
  })
  async createGuestOrder(
    @Body() orderData: {
      items: any[];
      delivery_address: string;
      delivery_date_time?: string;
      delivery_date?: string;
      delivery_time?: string;
      delivery_fee?: number;
      payment_method?: string;
      payment_intent_id?: string;
      notes?: string;
      coupon_code?: string;
      postcode?: string;
      firstname: string;
      lastname: string;
      email: string;
      telephone?: string;
    },
  ) {
    return this.storeOrdersService.createOrder(null, orderData);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get customer orders' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listOrders(
    @Request() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const userId = req.user?.user_id;
    if (!userId) {
      throw new Error('Unauthorized');
    }
    return this.storeOrdersService.listOrders(
      userId,
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 10,
    );
  }

  @Get(':id/public-view')
  @ApiOperation({ summary: 'Get order details for payment/invoice (no auth required)' })
  @ApiParam({ name: 'id', type: Number })
  async getOrderPublicView(
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.storeOrdersService.getOrderPublicView(id);
  }

  @Get(':id/invoice-pdf')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Download the tax-invoice PDF for an order' })
  @ApiParam({ name: 'id', type: Number })
  async getInvoicePdf(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const userId = req.user?.user_id;
    if (!userId) {
      throw new Error('Unauthorized');
    }
    const pdfBuffer = await this.storeOrdersService.getInvoicePdf(userId, id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="invoice-${id}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });
    res.end(pdfBuffer);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get single order details' })
  @ApiParam({ name: 'id', type: Number })
  async getOrder(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const userId = req.user?.user_id;
    if (!userId) {
      throw new Error('Unauthorized');
    }
    return this.storeOrdersService.getOrder(userId, id);
  }

  @Post(':id/upload-image')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upload order image (delivery notes)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FilesInterceptor('image', 1))
  async uploadOrderImage(
    @Request() req: any,
    @Param('id', ParseIntPipe) orderId: number,
    @UploadedFiles() files: Array<Express.Multer.File>,
  ) {
    const userId = req.user?.user_id;
    if (!userId) {
      throw new Error('Unauthorized');
    }

    if (!files || files.length === 0) {
      throw new BadRequestException('No file uploaded');
    }

    // Verify that the order belongs to the user
    const order = await this.storeOrdersService.getOrder(userId, orderId);
    if (!order) {
      throw new BadRequestException('Order not found or access denied');
    }

    return this.adminUploadService.uploadOrderImage(files, orderId);
  }
}
