import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody, ApiQuery } from '@nestjs/swagger';
import { StoreAuthService } from './store-auth.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';

@ApiTags('Store Auth')
@Controller('store/auth')
export class StoreAuthController {
  constructor(private readonly storeAuthService: StoreAuthService) { }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Customer login' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        password: { type: 'string' },
      },
      required: ['username', 'password'],
    },
  })
  async login(
    @Body('username') username: string,
    @Body('password') password: string,
  ) {
    return this.storeAuthService.login(username, password);
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Customer registration' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
        firstname: { type: 'string' },
        lastname: { type: 'string' },
        telephone: { type: 'string' },
        company_id: { type: 'number' },
        department_id: { type: 'number' },
        company_name: { type: 'string' },
        address_line1: { type: 'string' },
        address_line2: { type: 'string' },
        suburb: { type: 'string' },
        postal_code: { type: 'string' },
        state: { type: 'string' },
        service_type: { type: 'string' },
        estimated_opening_date: { type: 'string' },
        preferred_contact_method: { type: 'string' },
        business_type: { type: 'string' },
        wholesale_type: { type: 'string' },
        vip: { type: 'boolean' },
        customer_type: { type: 'string' },
      },
      required: ['email', 'username', 'password', 'firstname'],
    },
  })
  async register(@Body() registerDto: any) {
    return this.storeAuthService.register(registerDto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current customer info' })
  async getCurrentCustomer(@Request() req: any) {
    return this.storeAuthService.getCurrentCustomer(req.user.user_id);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
      },
      required: ['email'],
    },
  })
  async forgotPassword(@Body('email') email: string) {
    return this.storeAuthService.forgotPassword(email);
  }

  @Get('verify-reset-token')
  @ApiOperation({ summary: 'Verify password reset token' })
  @ApiQuery({ name: 'token', type: String, required: true })
  async verifyResetToken(@Query('token') token: string) {
    return this.storeAuthService.verifyResetToken(token);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using token' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        password: { type: 'string' },
      },
      required: ['token', 'password'],
    },
  })
  async resetPassword(
    @Body('token') token: string,
    @Body('password') password: string,
  ) {
    return this.storeAuthService.resetPassword(token, password);
  }

  @Post('update-password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update password for authenticated user' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        current_password: { type: 'string' },
        new_password: { type: 'string' },
      },
      required: ['current_password', 'new_password'],
    },
  })
  async updatePassword(
    @Request() req: any,
    @Body('current_password') currentPassword: string,
    @Body('new_password') newPassword: string,
  ) {
    return this.storeAuthService.updatePassword(req.user.user_id, currentPassword, newPassword);
  }

  @Post('update-profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update current customer profile' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        firstname: { type: 'string' },
        lastname: { type: 'string' },
        email: { type: 'string' },
        telephone: { type: 'string' },
        company_name: { type: 'string' },
        address_line1: { type: 'string' },
        address_line2: { type: 'string' },
        suburb: { type: 'string' },
        postal_code: { type: 'string' },
        state: { type: 'string' },
        business_type: { type: 'string' },
        estimated_opening_date: { type: 'string' },
        preferred_contact_method: { type: 'string' },
      },
    },
  })
  async updateProfile(@Request() req: any, @Body() updateDto: any) {
    return this.storeAuthService.updateProfile(req.user.user_id, updateDto);
  }
  @Get('check-email')
  @ApiOperation({ summary: 'Check if email is already registered' })
  @ApiQuery({ name: 'email', type: String, required: true })
  async checkEmail(@Query('email') email: string) {
    return this.storeAuthService.checkEmailAvailability(email);
  }
}


