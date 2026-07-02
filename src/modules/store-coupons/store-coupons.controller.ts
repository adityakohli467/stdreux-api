import {
  Controller,
  Get,
  Post,
  Body,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { StoreCouponsService } from './store-coupons.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';

@ApiTags('Store Coupons')
@Controller('store/coupons')
export class StoreCouponsController {
  constructor(private readonly storeCouponsService: StoreCouponsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get list of available coupons' })
  async getAvailableCoupons(@Request() req: any) {
    return this.storeCouponsService.getAvailableCoupons(
      req.headers.authorization,
    );
  }

  @Post('validate')
  @ApiOperation({ summary: 'Validate coupon code' })
  async validateCoupon(
    @Body() data: {
      coupon_code: string;
      order_total?: number;
      items?: Array<{
        product_id: number;
        quantity?: number;
        price?: number;
        total?: number;
      }>;
    },
    @Request() req: any,
  ) {
    return this.storeCouponsService.validateCoupon(
      data,
      req.headers.authorization,
    );
  }
}
