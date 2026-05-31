import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Request,
  Res,
  ParseIntPipe,
  Headers,
  UseGuards,
} from '@nestjs/common';
import { OptionalJwtAuthGuard } from '../../auth/guards/optional-jwt-auth.guard';
import type { Response } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiBody } from '@nestjs/swagger';
import { StorePaymentService } from './store-payment.service';

@ApiTags('Store Payment')
@Controller('store/payment')
export class StorePaymentController {
  constructor(private readonly storePaymentService: StorePaymentService) { }

  @Post('create-intent')
  @ApiOperation({ summary: 'Create Stripe Payment Intent' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        order_id: { type: 'number' },
      },
      required: ['order_id'],
    },
  })
  async createPaymentIntent(
    @Body() data: { order_id: number },
    @Request() req: any,
  ) {
    const ipAddress = req.ip || req.socket?.remoteAddress || null;
    const userAgent = req.get('user-agent') || null;
    return this.storePaymentService.createPaymentIntent(data, ipAddress, userAgent);
  }

  @Post('create-intent-for-cart')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Create Stripe Payment Intent for a cart before order' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'number' },
        email: { type: 'string' },
        firstname: { type: 'string' },
        lastname: { type: 'string' },
        telephone: { type: 'string' },
      },
      required: ['amount'],
    },
  })
  async createPaymentIntentForCart(
    @Body() data: {
      amount: number;
      email?: string;
      firstname?: string;
      lastname?: string;
      telephone?: string;
    },
    @Request() req: any,
  ) {
    const ipAddress = req.ip || req.socket?.remoteAddress || null;
    const userAgent = req.get('user-agent') || null;
    const userId = req.user?.user_id || null;
    return this.storePaymentService.createPaymentIntentForCart(data, userId, ipAddress, userAgent);
  }

  @Post('verify')
  @ApiOperation({ summary: 'Verify Stripe payment after client-side confirmation' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        payment_intent_id: { type: 'string' },
        order_id: { type: 'number' },
      },
      required: ['payment_intent_id'],
    },
  })
  async verifyPayment(@Body() data: { payment_intent_id: string; order_id?: number }) {
    return this.storePaymentService.verifyPayment(data);
  }

  @Post('cancel-intent')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Cancel a stale Stripe Payment Intent' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        payment_intent_id: { type: 'string' },
      },
      required: ['payment_intent_id'],
    },
  })
  async cancelPaymentIntent(@Body() data: { payment_intent_id: string }) {
    return this.storePaymentService.cancelPaymentIntent(data.payment_intent_id);
  }

  @Post('stripe/webhook')
  @ApiOperation({ summary: 'Handle Stripe webhooks' })
  async handleStripeWebhook(
    @Request() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    // Get raw body for signature verification
    // NestJS with rawBody: true provides rawBody as Buffer
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

    return this.storePaymentService.handleStripeWebhook(
      req.body,
      signature || '',
      rawBody,
    );
  }
}
