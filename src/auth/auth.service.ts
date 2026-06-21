import { Injectable, UnauthorizedException, BadRequestException, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User } from '../entities/User';
import { Customer } from '../entities/Customer';
import { Company } from '../entities/Company';
import { JwtPayload } from './strategies/jwt.strategy';
import { EmailService } from '../common/services/email.service';
import { NotificationService } from '../common/services/notification.service';

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private dataSource: DataSource,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailService: EmailService,
    private notificationService: NotificationService,
  ) { }

  async onModuleInit() {
    await this.ensurePasswordResetTableExists();
  }

  private async ensurePasswordResetTableExists() {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      // 1. Create table if it doesn't exist
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          token TEXT NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          used BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 2. Check for columns
      const columns = await queryRunner.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'password_reset_tokens'
      `);
      const existingColumns = columns.map((c: any) => c.column_name);

      if (!existingColumns.includes('used')) {
        await queryRunner.query('ALTER TABLE password_reset_tokens ADD COLUMN used BOOLEAN DEFAULT FALSE');
      }

      if (!existingColumns.includes('id')) {
        await queryRunner.query('ALTER TABLE password_reset_tokens ADD COLUMN id SERIAL PRIMARY KEY');
      }

    } catch (error) {
      console.error('Error ensuring password_reset_tokens table in AuthService:', error);
    } finally {
      await queryRunner.release();
    }
  }

  async login(username: string, password: string): Promise<any> {
    if (!username || !password) {
      throw new BadRequestException('Username and password are required');
    }

    // Find user by login_username or email
    const user = await this.dataSource.query(
      `SELECT * FROM "user" WHERE (login_username = $1 OR email = $1) LIMIT 1`,
      [username],
    );

    if (!user || user.length === 0) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const userData = user[0];

    // Verify password
    const isValid = await bcrypt.compare(password, userData.password);
    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Get customer details if user is a customer
    let customer = null;
    if (userData.is_customer === 1 || userData.auth_level >= 3) {
      const customerResult = await this.dataSource.query(
        `SELECT c.*, co.company_name, d.department_name
         FROM customer c
         LEFT JOIN company co ON c.company_id = co.company_id
         LEFT JOIN department d ON c.department_id = d.department_id
         WHERE c.user_id = $1`,
        [userData.user_id],
      );
      customer = customerResult[0] || null;
    }

    // Generate JWT token
    const token = this.jwtService.sign({
      user_id: userData.user_id,
      email: userData.email,
      auth_level: userData.auth_level,
      username: userData.username,
      customer_id: (customer as any)?.customer_id,
    });

    // Remove password from response
    const { password: _, ...userWithoutPassword } = userData;

    return {
      token,
      user: userWithoutPassword,
      customer,
      expiresIn: 14400, // 4 hours in seconds
    };
  }

  async register(registerDto: any): Promise<any> {
    const {
      email,
      username,
      password,
      firstname,
      lastname,
      telephone,
      login_username,
      auth_level = 3,
      is_customer = false,
      company_id,
      department_id,
      company_name,
      address_line1,
      address_line2,
      suburb,
      postal_code,
      state,
    } = registerDto;

    if (!email || !username || !password) {
      throw new BadRequestException('Email, username, and password are required');
    }

    // For customers, require firstname and lastname (check for empty strings too)
    if ((is_customer || auth_level >= 3) && (!firstname || !lastname || firstname.trim() === "" || lastname.trim() === "")) {
      throw new BadRequestException('First name and last name are required for customer registration');
    }

    // Check if user already exists
    const existingUser = await this.dataSource.query(
      `SELECT user_id FROM "user" WHERE email = $1 OR login_username = $2`,
      [email, login_username || username],
    );

    if (existingUser.length > 0) {
      throw new BadRequestException('User already exists with this email or username');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Determine auth_level and is_customer
    const finalAuthLevel = is_customer ? 3 : auth_level;
    const finalIsCustomer = is_customer ? 1 : 0;

    // Create user
    const userResult = await this.dataSource.query(
      `INSERT INTO "user" (email, username, login_username, password, auth_level, is_customer)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        email,
        firstname && lastname ? `${firstname} ${lastname}` : username,
        login_username || username,
        hashedPassword,
        finalAuthLevel,
        finalIsCustomer,
      ],
    );

    const user = userResult[0];
    let finalCompanyId = company_id || null;
    let customer = null;

    // Create company if wholesaler and company_name provided
    if (company_name) {
      const addressParts = [address_line1, address_line2, suburb, state, postal_code].filter(Boolean);
      const fullAddress = addressParts.join(', ');

      const companyResult = await this.dataSource.query(
        `INSERT INTO company (user_id, company_name, company_address, company_status, created_from)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING company_id`,
        [user.user_id, company_name, fullAddress || null, 1, 'storefront_registration'],
      );

      finalCompanyId = companyResult[0].company_id;
    }

    // Create customer record if customer
    if (finalIsCustomer === 1 || finalAuthLevel >= 3) {
      const addressParts = [address_line1, address_line2, suburb, state, postal_code].filter(Boolean);
      const customerAddress = addressParts.join(', ');

      const approved = !company_name; // Regular customers auto-approved

      const customerResult = await this.dataSource.query(
        `INSERT INTO customer (user_id, firstname, lastname, email, telephone, company_id, department_id, customer_address, customer_date_added, status, approved)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), 1, $9)
         RETURNING *`,
        [
          user.user_id,
          firstname,
          lastname,
          email,
          telephone || null,
          finalCompanyId,
          department_id || null,
          customerAddress || null,
          approved,
        ],
      );

      customer = customerResult[0];
    }

    // Generate JWT token
    const token = this.jwtService.sign({
      user_id: user.user_id,
      email: user.email,
      auth_level: user.auth_level,
      username: user.username,
      customer_id: (customer as any)?.customer_id,
    });

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    // After creating customer record, send notification if wholesale premium/essential
    try {
      const customerName = firstname && lastname ? `${firstname} ${lastname}` : username;
      const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
      const loginUrl = `${frontendUrl}/auth/login`;
      const contactNumber = this.configService.get<string>('COMPANY_PHONE') || '';
      const contactEmail = this.configService.get<string>('COMPANY_EMAIL') || '';
      const companyNameVar = this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee';
      const { wholesale_type, service_type } = registerDto;
      if (company_name) {
        const isWholesalePremium =
          (wholesale_type && wholesale_type.toLowerCase().includes('premium')) ||
          (service_type && service_type.toLowerCase().includes('premium'));
        const isWholesaleEssential =
          (wholesale_type && wholesale_type.toLowerCase().includes('essential')) ||
          (service_type && service_type.toLowerCase().includes('essential'));
        if (isWholesalePremium) {
          // Send to User
          await this.notificationService.sendNotification({
            templateKey: 'wholesale_premium_pending',
            recipientEmail: email,
            recipientName: customerName,
            variables: {
              customer_name: customerName,
              contact_number: contactNumber,
              contact_email: contactEmail,
              company_name: companyNameVar,
            },
            customSubject: `Welcome to ${companyNameVar} – Wholesale Premium Account Pending Approval`,
            customBody: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; }
    .header { background-color: #2952E6; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
    .footer { padding: 20px; color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${companyNameVar}</h1>
    </div>
    <div class="content">
      <p>Dear ${customerName},</p>
      <p>Welcome to ${companyNameVar}.</p>
      <p>Your Wholesale Premium account has been successfully created and is currently pending approval by the store manager. Once your account is approved, you will be able to log in, access premium wholesale pricing, and place orders online.</p>
      <p>You will be notified once your account has been approved.</p>
      <p>If you have any questions, please contact us at ${contactNumber} or ${contactEmail}</p>
      <p>Kind regards,<br/>${companyNameVar} Team</p>
    </div>
  </div>
</body>
</html>`,
          });
        } else if (isWholesaleEssential) {
          // Send to User
          await this.notificationService.sendNotification({
            templateKey: 'wholesale_essential_pending',
            recipientEmail: email,
            recipientName: customerName,
            variables: {
              customer_name: customerName,
              contact_number: contactNumber,
              contact_email: contactEmail,
              company_name: companyNameVar,
            },
            customSubject: `Welcome to ${companyNameVar} – Wholesale Essential Account Pending Approval`,
            customBody: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; }
    .header { background-color: #2952E6; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
    .footer { padding: 20px; color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${companyNameVar}</h1>
    </div>
    <div class="content">
      <p>Dear ${customerName},</p>
      <p>Welcome to ${companyNameVar}.</p>
      <p>Your **Wholesale Essential** account has been successfully created and is currently pending approval by the store manager. Once your account is approved, you will be able to log in, access wholesale pricing, and place orders online.</p>
      <p>You will be notified once your account has been approved.</p>
      <p>If you have any questions, please contact us at ${contactNumber} or ${contactEmail}.</p>
      <p>Kind regards,<br/>${companyNameVar} Team</p>
    </div>
  </div>
</body>
</html>`,
          });
        }

        // Notify Admin
        if (contactEmail) {
          await this.notificationService.sendNotification({
            templateKey: 'admin_new_wholesale_notification',
            recipientEmail: contactEmail,
            recipientName: 'Admin',
            variables: {
              customer_name: customerName,
              customer_email: email,
              company_name: company_name,
              wholesale_type: isWholesalePremium ? 'Wholesale Premium' : (isWholesaleEssential ? 'Wholesale Essential' : 'Wholesale'),
            },
            customSubject: `New Wholesaler Registration: ${company_name}`,
            customBody: `
<!DOCTYPE html>
<html>
<body>
  <h2>New Wholesaler Registration Received</h2>
  <p>A new wholesaler has registered and is pending approval.</p>
  <ul>
    <li><strong>Company:</strong> ${company_name}</li>
    <li><strong>Contact Name:</strong> ${customerName}</li>
    <li><strong>Email:</strong> ${email}</li>
    <li><strong>Type:</strong> ${isWholesalePremium ? 'Wholesale Premium' : (isWholesaleEssential ? 'Wholesale Essential' : 'Wholesale')}</li>
  </ul>
  <p>Please log in to the admin panel to review and approve this account.</p>
</body>
</html>`,
          });
        }
      }
    } catch (error) {
      // Log error but don't fail registration
      console.error('Failed to send wholesale registration email:', error);
    }

    return {
      token,
      user: userWithoutPassword,
      customer,
      message: company_name
        ? 'Registration successful. Your account is pending approval.'
        : 'Registration successful',
      expiresIn: 604800,
    };
  }

  async getCurrentUser(userId: number): Promise<any> {
    const userResult = await this.dataSource.query(
      `SELECT user_id, email, username, login_username, auth_level, merchant_id, merchant_pass, abn,
              company_name, account_name, account_number, bsb, user_com_addr, account_email,
              account_uid, guid, is_customer, created_at, updated_at
       FROM "user"
       WHERE user_id = $1`,
      [userId],
    );

    if (!userResult || userResult.length === 0) {
      throw new NotFoundException('User not found');
    }

    const user = userResult[0];

    // Get customer details if user is a customer
    let customer = null;
    if (user.is_customer === 1 || user.auth_level === 3) {
      const customerResult = await this.dataSource.query(
        `SELECT c.customer_id, c.firstname, c.lastname, c.email, c.telephone,
                c.customer_date_added, c.status, c.approved,
                co.company_name, d.department_name
         FROM customer c
         LEFT JOIN company co ON c.company_id = co.company_id
         LEFT JOIN department d ON c.department_id = d.department_id
         WHERE c.user_id = $1`,
        [userId],
      );
      customer = customerResult[0] || null;
    }

    return {
      user,
      customer,
    };
  }

  async forgotPassword(email: string): Promise<any> {
    if (!email) {
      throw new BadRequestException('Email is required');
    }

    // Find user by email
    const userResult = await this.dataSource.query(
      `SELECT user_id, email, username FROM "user" 
       WHERE email = $1 AND (auth_level >= 3 OR is_customer = 1) LIMIT 1`,
      [email],
    );

    // Always return success to prevent email enumeration
    if (!userResult || userResult.length === 0) {
      return {
        message: 'If an account exists with this email, a password reset link has been sent.',
      };
    }

    const user = userResult[0];

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1); // Token expires in 1 hour

    // Delete any existing tokens for this user
    await this.dataSource.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.user_id]);

    // Save reset token
    await this.dataSource.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [user.user_id, resetToken, expiresAt],
    );

    // Send reset email
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const resetUrl = `${frontendUrl}/auth/reset-password?token=${resetToken}`;

    await this.emailService.sendEmail({
      to: user.email,
      subject: 'Reset Your Password - St Dreux Coffee',
      html: (() => {
        const contactNumber = this.configService.get<string>('COMPANY_PHONE') || '';
        const contactEmail = this.configService.get<string>('COMPANY_EMAIL') || '';
        const companyName = this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee';
        return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 0 auto; background-color: #fff; padding: 20px; }
    .header { background-color: #2952E6; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
    .button { display: inline-block; padding: 12px 24px; background-color: #2952E6; color: #ffffff !important; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Reset Your Password</h1>
    </div>
    <div class="content">
      <p>Dear ${user.username || 'Customer'},</p>
      <p>We received a request to reset the password for your ${companyName} account.</p>
      <p>To reset your password, please click the link below:</p>
      <div style="text-align: center;">
        <a href="${resetUrl}" class="button" style="color: #ffffff !important; text-decoration: none; display: inline-block;">
          <span style="color: #ffffff !important; text-decoration: none;">Reset Password</span>
        </a>
      </div>
      <p>Or copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #666;">${resetUrl}</p>
      <p>If you did not request a password reset, please disregard this email.</p>
      <p>If you have any questions, please contact us at ${contactNumber} or ${contactEmail}.</p>
      <p>Kind regards,<br/>${companyName} Team</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
        `;
      })(),
    });

    return {
      message: 'If an account exists with this email, a password reset link has been sent.',
    };
  }

  async verifyResetToken(token: string): Promise<any> {
    const tokenResult = await this.dataSource.query(
      `SELECT prt.*, u.email FROM password_reset_tokens prt
       JOIN "user" u ON prt.user_id = u.user_id
       WHERE prt.token = $1 AND prt.used = FALSE`,
      [token],
    );

    if (!tokenResult || tokenResult.length === 0) {
      throw new BadRequestException('Invalid token');
    }

    const tokenData = tokenResult[0];

    if (new Date(tokenData.expires_at) < new Date()) {
      throw new BadRequestException('Token has expired');
    }

    return {
      valid: true,
      email: tokenData.email,
    };
  }

  async resetPassword(token: string, password: string): Promise<any> {
    if (!token || !password) {
      throw new BadRequestException('Token and password are required');
    }

    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }

    // Find token
    const tokenResult = await this.dataSource.query(
      `SELECT prt.*, u.user_id, u.email FROM password_reset_tokens prt
       JOIN "user" u ON prt.user_id = u.user_id
       WHERE prt.token = $1 AND prt.used = FALSE`,
      [token],
    );

    if (!tokenResult || tokenResult.length === 0) {
      throw new BadRequestException('Invalid or expired token');
    }

    const tokenData = tokenResult[0];

    if (new Date(tokenData.expires_at) < new Date()) {
      throw new BadRequestException('Token has expired');
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update password
    await this.dataSource.query(
      `UPDATE "user" SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
      [hashedPassword, tokenData.user_id],
    );

    // Mark token as used
    await this.dataSource.query('UPDATE password_reset_tokens SET used = TRUE WHERE id = $1', [tokenData.id]);

    return {
      message: 'Password reset successfully',
    };
  }
}
