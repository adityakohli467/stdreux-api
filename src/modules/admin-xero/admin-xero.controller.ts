import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  UseGuards,
  ParseIntPipe,
  BadRequestException,
  Delete,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AdminXeroService } from './admin-xero.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../../auth/guards/admin.guard';

@ApiTags('Admin Xero')
@Controller('admin/xero')
export class AdminXeroController {
  constructor(private readonly xeroService: AdminXeroService) {}

  /**
   * Get Xero OAuth authorization URL
   */
  @Get('auth-url')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Xero OAuth authorization URL' })
  async getAuthUrl() {
    const url = await this.xeroService.getAuthUrl();
    return { success: true, url };
  }

  /**
   * Handle OAuth callback from Xero
   * Frontend sends the full callback URL after Xero redirects back
   */
  @Get('callback')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Handle Xero OAuth callback' })
  async handleCallback(@Query('url') url: string) {
    if (!url) {
      throw new BadRequestException('Callback URL is required');
    }
    const result = await this.xeroService.handleCallback(url);
    return { ...result };
  }

  /**
   * Check if Xero is connected
   */
  @Get('status')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check Xero connection status' })
  async getStatus() {
    const status = await this.xeroService.isConnected();
    return { success: true, ...status };
  }

  /**
   * Disconnect Xero
   */
  @Post('disconnect')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disconnect Xero integration' })
  async disconnect() {
    await this.xeroService.disconnect();
    return { success: true, message: 'Xero disconnected successfully' };
  }

  /**
   * Create invoice in Xero for a paid order
   */
  @Post('invoice/:orderId')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create Xero invoice for an order' })
  async createInvoice(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Query('force') force?: string,
  ) {
    if (force === 'true') {
      await this.xeroService.removeSyncRecord(orderId);
    }
    const result = await this.xeroService.createInvoiceForOrder(orderId);
    return {
      success: true,
      message: `Invoice ${result.invoiceNumber} created in Xero`,
      ...result,
    };
  }
}
