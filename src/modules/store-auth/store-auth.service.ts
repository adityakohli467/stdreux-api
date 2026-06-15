import { Injectable, UnauthorizedException, BadRequestException, NotFoundException, ForbiddenException, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { EmailService } from '../../common/services/email.service';
import { NotificationService } from '../../common/services/notification.service';

@Injectable()
export class StoreAuthService implements OnModuleInit {
  private readonly logger = new Logger(StoreAuthService.name);
  constructor(
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

      // 2. Check for columns to ensure backward compatibility
      const columns = await queryRunner.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'password_reset_tokens'
      `);
      const existingColumns = columns.map((c: any) => c.column_name);

      if (!existingColumns.includes('used')) {
        await queryRunner.query('ALTER TABLE password_reset_tokens ADD COLUMN used BOOLEAN DEFAULT FALSE');
        this.logger.log('Added "used" column to password_reset_tokens');
      }

      if (!existingColumns.includes('id')) {
        await queryRunner.query('ALTER TABLE password_reset_tokens ADD COLUMN id SERIAL PRIMARY KEY');
        this.logger.log('Added "id" column to password_reset_tokens');
      }

    } catch (error) {
      this.logger.error('Error ensuring password_reset_tokens table:', error);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Customer Login
   */
  async login(username: string, password: string): Promise<any> {
    if (!username || !password) {
      throw new BadRequestException('Username and password are required');
    }

    // Find user by login_username or email
    const query = `
      SELECT * FROM "user" 
      WHERE (login_username = $1 OR email = $1)
      LIMIT 1
    `;
    const result = await this.dataSource.query(query, [username]);
    const user = result[0];

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check if user is customer (auth_level >= 3 or is_customer = 1)
    if (user.auth_level < 3 && user.is_customer !== 1) {
      throw new ForbiddenException('Access denied. Customer account required.');
    }

    // Get customer details
    const customerQuery = `
      SELECT 
        c.*,
        COALESCE(c.pay_later, false) as pay_later,
        co.company_name,
        d.department_name
      FROM customer c
      LEFT JOIN company co ON c.company_id = co.company_id
      LEFT JOIN department d ON c.department_id = d.department_id
      WHERE c.user_id = $1
    `;
    const customerResult = await this.dataSource.query(customerQuery, [user.user_id]);
    const customer = customerResult[0] || null;

    // Generate JWT token
    const token = this.jwtService.sign({
      user_id: user.user_id,
      email: user.email,
      auth_level: user.auth_level,
      username: user.username,
      customer_id: customer?.customer_id,
    });

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    return {
      token,
      user: userWithoutPassword,
      customer,
      expiresIn: 14400, // 4 hours in seconds
    };
  }

  /**
   * Customer Registration
   */
  async register(registerDto: {
    email: string;
    username: string;
    password: string;
    firstname: string;
    lastname?: string;
    telephone?: string;
    company_id?: number;
    department_id?: number;
    company_name?: string;
    address_line1?: string;
    address_line2?: string;
    suburb?: string;
    postal_code?: string;
    state?: string;
    service_type?: string;
    estimated_opening_date?: string;
    preferred_contact_method?: string;
    business_type?: string;
    wholesale_type?: string;
  }): Promise<any> {
    const {
      email,
      username,
      password,
      firstname,
      lastname,
      telephone,
      company_id,
      department_id,
      company_name,
      address_line1,
      address_line2,
      suburb,
      postal_code,
      state,
      service_type,
      estimated_opening_date,
      preferred_contact_method,
      business_type,
      wholesale_type,
    } = registerDto;

    if (!email || !username || !password || !firstname) {
      throw new BadRequestException('All required fields must be provided');
    }

    // Check if user already exists
    const checkQuery = `
      SELECT user_id FROM "user" 
      WHERE email = $1 OR login_username = $2
    `;
    const checkResult = await this.dataSource.query(checkQuery, [email, username]);

    if (checkResult.length > 0) {
      throw new BadRequestException('User already exists with this email or username');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const userQuery = `
      INSERT INTO "user" (
        email,
        username,
        login_username,
        password,
        auth_level,
        is_customer
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const userResult = await this.dataSource.query(userQuery, [
      email,
      lastname ? `${firstname} ${lastname}`.trim() : firstname,
      username,
      hashedPassword,
      3, // Customer auth level
      1, // is_customer flag
    ]);

    const user = userResult[0];
    let finalCompanyId = company_id || null;

    // Create company if wholesaler and company_name provided
    if (company_name) {
      const addressParts = [
        address_line1,
        address_line2,
        suburb,
        state,
        postal_code,
      ].filter(Boolean);
      const fullAddress = addressParts.join(', ');

      const companyQuery = `
        INSERT INTO company (
          user_id,
          company_name,
          company_address,
          company_status,
          created_from
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING company_id
      `;

      const companyResult = await this.dataSource.query(companyQuery, [
        user.user_id,
        company_name,
        fullAddress || null,
        1, // Active
        'storefront_registration',
      ]);

      finalCompanyId = companyResult[0].company_id;
    }

    // Build customer address
    const addressParts = [
      address_line1,
      address_line2,
      suburb,
      state,
      postal_code,
    ].filter(Boolean);
    const customerAddress = addressParts.join(', ');

    // Check which columns exist in customer table
    const columnCheck = await this.dataSource.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'customer' 
      AND column_name IN ('service_type', 'estimated_opening_date', 'preferred_contact_method', 'business_type', 'wholesale_type', 'customer_type')
    `);
    const existingColumns = columnCheck.map((row: any) => row.column_name);
    const hasServiceType = existingColumns.includes('service_type');
    const hasEstimatedOpeningDate = existingColumns.includes('estimated_opening_date');
    const hasPreferredContactMethod = existingColumns.includes('preferred_contact_method');
    const hasBusinessType = existingColumns.includes('business_type');
    const hasWholesaleType = existingColumns.includes('wholesale_type');
    const hasCustomerType = existingColumns.includes('customer_type');

    // Build columns and values arrays
    const columns = [
      'user_id',
      'firstname',
      'lastname',
      'email',
      'telephone',
      'company_id',
      'department_id',
      'customer_address',
      'customer_date_added',
      'status',
      'approved',
      'created_from'
    ];
    const values: any[] = [
      user.user_id,
      firstname,
      lastname || null,
      email,
      telephone || null,
      finalCompanyId,
      department_id || null,
      customerAddress || null,
      null, // Will be replaced with NOW()
      1,
      !company_name ? true : false, // Regular customers auto-approved, wholesalers need approval
      'storefront'
    ];

    // Add optional columns if they exist
    if (hasServiceType && service_type) {
      columns.push('service_type');
      values.push(service_type);
    }
    if (hasEstimatedOpeningDate && estimated_opening_date) {
      columns.push('estimated_opening_date');
      values.push(estimated_opening_date);
    }
    if (hasPreferredContactMethod && preferred_contact_method) {
      columns.push('preferred_contact_method');
      values.push(preferred_contact_method);
    }
    if (hasBusinessType && business_type) {
      columns.push('business_type');
      values.push(business_type);
    }
    if (hasWholesaleType && wholesale_type) {
      columns.push('wholesale_type');
      values.push(wholesale_type);
    }
    if (hasCustomerType && company_name) {
      // Set customer_type based on service_type
      let customerTypeValue = 'Retail';
      if (service_type === 'Full Service Wholesaler') {
        customerTypeValue = 'Full Service Wholesale';
      } else if (service_type === 'Half Service') {
        customerTypeValue = 'Partial Service Wholesale';
      }
      columns.push('customer_type');
      values.push(customerTypeValue);
    }

    // Build placeholders - NOW() for customer_date_added, $N for others
    const placeholders: string[] = [];
    let paramIndex = 1;
    for (let i = 0; i < columns.length; i++) {
      if (columns[i] === 'customer_date_added') {
        placeholders.push('NOW()');
      } else {
        placeholders.push(`$${paramIndex}`);
        paramIndex++;
      }
    }

    // Remove null from values array where NOW() is used
    const finalValues = values.filter((val, idx) => columns[idx] !== 'customer_date_added');

    const customerQuery = `
      INSERT INTO customer (
        ${columns.join(', ')}
      ) VALUES (
        ${placeholders.join(', ')}
      )
      RETURNING *
    `;

    const customerResult = await this.dataSource.query(customerQuery, finalValues);

    const customer = customerResult[0];

    // Send registration notification email
    try {
      const customerName = lastname ? `${firstname} ${lastname}`.trim() : firstname;
      const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
      const loginUrl = `${frontendUrl}/auth/login`;
      const contactNumber = this.configService.get<string>('COMPANY_PHONE') || '';
      const contactEmail = this.configService.get<string>('COMPANY_EMAIL') || '';
      const adminEmails = this.configService.get<string>('ADMIN_NOTIFICATION_EMAILS') || contactEmail || '';
      const adminEmailList = adminEmails.split(',').map(e => e.trim()).filter(Boolean);
      const companyNameVar = this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee';

      // Handle both snake_case (from API) and camelCase (potential frontend format)
      const wholesaleType = registerDto.wholesale_type || (registerDto as any).wholesaleType;
      const serviceType = registerDto.service_type || (registerDto as any).serviceType;

      if (company_name) {
        const isWholesalePremium =
          (wholesaleType && wholesaleType.toLowerCase().includes('premium')) ||
          (serviceType && serviceType.toLowerCase().includes('premium'));
        const isWholesaleEssential =
          (wholesaleType && wholesaleType.toLowerCase().includes('essential')) ||
          (serviceType && serviceType.toLowerCase().includes('essential'));

        if (isWholesalePremium) {
          // Send Wholesale Premium Pending Approval email to User
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
          // Send Wholesale Essential Pending Approval email to User
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
        } else {
          // Fallback to generic wholesale registration
          await this.notificationService.sendNotification({
            templateKey: 'wholesale_registration',
            recipientEmail: email,
            recipientName: customerName,
            variables: {
              customer_name: customerName,
              status: 'pending',
              approved: false,
            },
            customSubject: `Welcome to ${companyNameVar} – Wholesale Account Pending Approval`,
            customBody: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Welcome to ${companyNameVar}</h2>
    <p>Dear ${customerName},</p>
    <p>Your wholesale account has been successfully created and is currently pending approval.</p>
    <p>You will be notified once your account has been approved.</p>
    <p>Kind regards,<br/>${companyNameVar} Team</p>
  </div>
</body>
</html>`,
          });
        }

        // Notify Admin about new Wholesaler registration
        if (adminEmailList.length > 0) {
          await this.notificationService.sendNotification({
            templateKey: 'admin_new_wholesale_notification',
            recipientEmail: adminEmailList,
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
  <p>A new wholesaler has registered on the storefront and is pending approval.</p>
  <ul>
    <li><strong>Company:</strong> ${company_name}</li>
    <li><strong>Contact Name:</strong> ${customerName}</li>
    <li><strong>Email:</strong> ${email}</li>
    <li><strong>Type:</strong> ${isWholesalePremium ? 'Wholesale Premium' : (isWholesaleEssential ? 'Wholesale Essential' : 'Wholesale')}</li>
    <li><strong>Service Type:</strong> ${serviceType || 'N/A'}</li>
  </ul>
  <p>Please log in to the admin panel to review and approve this account.</p>
</body>
</html>`,
          });
        }
      } else {
        // Regular customer registration
        await this.notificationService.sendNotification({
          templateKey: 'customer_registration',
          recipientEmail: email,
          recipientName: customerName,
          variables: {},
          customSubject: 'Welcome to St Dreux Coffee – Your Account is Ready',
          customBody: (() => {
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
      <h1>${companyNameVar}</h1>
    </div>
    <div class="content">
      <p>Dear ${customerName},</p>
      <p>Welcome to ${companyNameVar}.</p>
      <p>Your retailer account has been successfully created. You can now sign in to browse products, place orders, and manage your account anytime.</p>
      <div style="text-align: center;">
        <a href="${loginUrl}" class="button" style="color: #ffffff !important; text-decoration: none; display: inline-block;">
          <span style="color: #ffffff !important; text-decoration: none;">Login Here</span>
        </a>
      </div>
      <p>If you have any questions, please contact us at ${contactNumber} ${contactEmail}.</p>
      <p>Kind regards,<br/>${companyNameVar} Team</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${companyNameVar}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
            `;
          })(),
        });

        // Notify Admin about new Regular Customer registration
        if (adminEmailList.length > 0) {
          await this.notificationService.sendNotification({
            templateKey: 'admin_new_customer_notification',
            recipientEmail: adminEmailList,
            recipientName: 'Admin',
            variables: {
              customer_name: customerName,
              customer_email: email,
              customer_phone: telephone || 'N/A',
            },
            customSubject: `New Customer Registration: ${customerName}`,
            customBody: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 0 auto; background-color: #fff; padding: 20px; }
    .header { background-color: #0d6efd; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
    .field { margin-bottom: 10px; }
    .label { font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>New Customer Registration</h1>
    </div>
    <div class="content">
      <p>A new regular customer has registered on the storefront:</p>
      <div class="field"><span class="label">Name:</span> ${customerName}</div>
      <div class="field"><span class="label">Email:</span> ${email}</div>
      <div class="field"><span class="label">Phone:</span> ${telephone || 'N/A'}</div>
      <p>The account has been automatically approved and is ready for use.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${companyNameVar}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
          });
        }
      }
    } catch (error: any) {
      // Log error but don't fail registration
      console.error('Failed to send registration email:', error);
    }

    // Generate JWT token for auto-login
    const token = this.jwtService.sign({
      user_id: user.user_id,
      email: user.email,
      auth_level: user.auth_level,
      username: user.username,
      customer_id: customer?.customer_id,
    });

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    return {
      token,
      user: userWithoutPassword,
      customer,
      message: company_name
        ? 'Registration successful. Your account is pending approval.'
        : 'Registration successful',
      expiresIn: 14400, // 4 hours in seconds
    };
  }

  /**
   * Get current customer info
   */
  async getCurrentCustomer(userId: number): Promise<any> {
    // Get user details
    const userQuery = `
      SELECT * FROM "user" 
      WHERE user_id = $1
    `;
    const userResult = await this.dataSource.query(userQuery, [userId]);
    const user = userResult[0];

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Get customer details with company and department
    const customerQuery = `
      SELECT 
        c.*,
        COALESCE(c.pay_later, false) as pay_later,
        co.company_name,
        co.company_abn as abn,
        d.department_name
      FROM customer c
      LEFT JOIN company co ON c.company_id = co.company_id
      LEFT JOIN department d ON c.department_id = d.department_id
      WHERE c.user_id = $1
    `;
    const customerResult = await this.dataSource.query(customerQuery, [userId]);
    const customer = customerResult[0] || null;

    // Remove password from response
    const { password, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      customer,
    };
  }

  /**
   * Request password reset
   */
  async forgotPassword(email: string): Promise<any> {
    if (!email) {
      throw new BadRequestException('Email is required');
    }

    // Find user by email
    const userQuery = `
      SELECT user_id, email, username 
      FROM "user" 
      WHERE email = $1 AND (auth_level >= 3 OR is_customer = 1)
      LIMIT 1
    `;
    const userResult = await this.dataSource.query(userQuery, [email]);
    const user = userResult[0];

    // Always return success to prevent email enumeration
    if (!user) {
      return {
        message: 'If an account exists with this email, a password reset link has been sent.',
      };
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1); // Token expires in 1 hour

    // Delete any existing tokens for this user
    await this.dataSource.query(
      'DELETE FROM password_reset_tokens WHERE user_id = $1',
      [user.user_id]
    );

    // Save reset token
    await this.dataSource.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [user.user_id, resetToken, expiresAt]
    );

    // Send reset email
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const resetUrl = `${frontendUrl}/auth/reset-password?token=${resetToken}`;

    await this.notificationService.sendNotification({
      templateKey: 'forgot_password',
      recipientEmail: user.email,
      recipientName: user.username || 'Customer',
      variables: {},
      customSubject: 'Reset Your Password - St Dreux Coffee',
      customBody: (() => {
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

  /**
   * Verify password reset token
   */
  async verifyResetToken(token: string): Promise<any> {
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Token is required');
    }

    // Find token
    const tokenQuery = `
      SELECT prt.*, u.email, u.username
      FROM password_reset_tokens prt
      JOIN "user" u ON prt.user_id = u.user_id
      WHERE prt.token = $1 AND prt.used = FALSE
    `;
    const tokenResult = await this.dataSource.query(tokenQuery, [token]);
    const tokenData = tokenResult[0];

    if (!tokenData) {
      throw new BadRequestException('Invalid or expired token');
    }

    // Check if token is expired
    if (new Date(tokenData.expires_at) < new Date()) {
      throw new BadRequestException('Token has expired');
    }

    return {
      valid: true,
      message: 'Token is valid',
      email: tokenData.email,
    };
  }

  /**
   * Reset password using token
   */
  async resetPassword(token: string, password: string): Promise<any> {
    if (!token || !password) {
      throw new BadRequestException('Token and password are required');
    }

    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }

    // Find token
    const tokenQuery = `
      SELECT prt.*, u.user_id, u.email
      FROM password_reset_tokens prt
      JOIN "user" u ON prt.user_id = u.user_id
      WHERE prt.token = $1 AND prt.used = FALSE
    `;
    const tokenResult = await this.dataSource.query(tokenQuery, [token]);
    const tokenData = tokenResult[0];

    if (!tokenData) {
      throw new BadRequestException('Invalid or expired token');
    }

    // Check if token is expired
    if (new Date(tokenData.expires_at) < new Date()) {
      throw new BadRequestException('Token has expired');
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update password
    await this.dataSource.query(
      'UPDATE "user" SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
      [hashedPassword, tokenData.user_id]
    );

    // Mark token as used
    await this.dataSource.query(
      'UPDATE password_reset_tokens SET used = TRUE WHERE id = $1',
      [tokenData.id]
    );

    return {
      message: 'Password reset successfully',
    };
  }

  /**
   * Update password for authenticated user
   */
  async updatePassword(userId: number, currentPassword: string, newPassword: string): Promise<any> {
    if (!userId) {
      throw new UnauthorizedException('Unauthorized');
    }

    if (!currentPassword || !newPassword) {
      throw new BadRequestException('Current password and new password are required');
    }

    if (newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters long');
    }

    // Get user
    const userQuery = `SELECT user_id, password FROM "user" WHERE user_id = $1`;
    const userResult = await this.dataSource.query(userQuery, [userId]);
    const user = userResult[0];

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Verify current password
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await this.dataSource.query(
      'UPDATE "user" SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
      [hashedPassword, userId]
    );

    return {
      message: 'Password updated successfully',
    };
  }

  /**
   * Update current customer profile
   */
  async updateProfile(userId: number, updateDto: any): Promise<any> {
    const {
      firstname,
      lastname,
      email,
      telephone,
      address_line1,
      address_line2,
      suburb,
      state,
      postal_code,
      business_type,
      company_name,
      estimated_opening_date,
      preferred_contact_method,
    } = updateDto;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 0. Check existing columns in customer and user tables to avoid "column does not exist" errors
      const customerColumnCheck = await queryRunner.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'customer'
      `);
      const existingCustomerColumns = customerColumnCheck.map((row: any) => row.column_name);

      const userColumnCheck = await queryRunner.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'user'
      `);
      const existingUserColumns = userColumnCheck.map((row: any) => row.column_name);

      // 1. Update user table
      const userUpdates: string[] = [];
      const userParams: any[] = [];
      let userParamIndex = 1;

      if (email) {
        userUpdates.push(`email = $${userParamIndex++}`);
        userParams.push(email);
      }

      if (firstname || lastname) {
        // Collect existing columns for select
        const nameCols: string[] = [];
        if (existingCustomerColumns.includes('firstname')) nameCols.push('firstname');
        if (existingCustomerColumns.includes('lastname')) nameCols.push('lastname');

        let currentFirstname = firstname;
        let currentLastname = lastname;

        if (nameCols.length > 0) {
          const currentUserQuery = await queryRunner.query(`SELECT ${nameCols.join(', ')} FROM customer WHERE user_id = $1`, [userId]);
          if (currentUserQuery[0]) {
            if (firstname === undefined && existingCustomerColumns.includes('firstname')) currentFirstname = currentUserQuery[0].firstname;
            if (lastname === undefined && existingCustomerColumns.includes('lastname')) currentLastname = currentUserQuery[0].lastname;
          }
        }

        if (existingUserColumns.includes('username')) {
          userUpdates.push(`username = $${userParamIndex++}`);
          userParams.push(`${currentFirstname || ''} ${currentLastname || ''}`.trim());
        }

        // Update individual name fields in user table if they exist
        if (currentFirstname !== undefined && existingUserColumns.includes('firstname')) {
          userUpdates.push(`firstname = $${userParamIndex++}`);
          userParams.push(currentFirstname);
        }
        if (currentLastname !== undefined && existingUserColumns.includes('lastname')) {
          userUpdates.push(`lastname = $${userParamIndex++}`);
          userParams.push(currentLastname);
        }
      }

      if (userUpdates.length > 0) {
        userParams.push(userId);
        const userUpdateCol = existingUserColumns.includes('date_modified') ? 'date_modified' : (existingUserColumns.includes('updated_at') ? 'updated_at' : null);
        const updateQueryString = `UPDATE "user" SET ${userUpdates.join(', ')}${userUpdateCol ? `, ${userUpdateCol} = CURRENT_TIMESTAMP` : ''} WHERE user_id = $${userParamIndex}`;
        await queryRunner.query(updateQueryString, userParams);
      }

      // 2. Update customer table
      const customerUpdates: string[] = [];
      const customerParams: any[] = [];
      let customerParamIndex = 1;

      const fieldsMapping: any = {
        firstname,
        lastname,
        email,
        telephone,
        address_line1,
        address_line2,
        suburb,
        state,
        postal_code,
        business_type,
        estimated_opening_date,
        preferred_contact_method,
      };

      for (const [key, value] of Object.entries(fieldsMapping)) {
        if (value !== undefined && existingCustomerColumns.includes(key)) {
          customerUpdates.push(`${key} = $${customerParamIndex++}`);
          customerParams.push(value);
        }
      }

      // Rebuild customer_address if any address field is updated or if customer_address exists
      if (existingCustomerColumns.includes('customer_address') &&
        (address_line1 !== undefined || address_line2 !== undefined || suburb !== undefined || state !== undefined || postal_code !== undefined)) {

        // Only select columns that actually exist
        const addrCols = ['address_line1', 'address_line2', 'suburb', 'state', 'postal_code', 'customer_address'].filter(col => existingCustomerColumns.includes(col));

        let c = {};
        if (addrCols.length > 0) {
          const customerResult = await queryRunner.query(`SELECT ${addrCols.join(', ')} FROM customer WHERE user_id = $1`, [userId]);
          c = customerResult[0] || {};
        }

        const parts = [
          address_line1 !== undefined ? address_line1 : (existingCustomerColumns.includes('address_line1') ? (c as any).address_line1 : null),
          address_line2 !== undefined ? address_line2 : (existingCustomerColumns.includes('address_line2') ? (c as any).address_line2 : null),
          suburb !== undefined ? suburb : (existingCustomerColumns.includes('suburb') ? (c as any).suburb : null),
          state !== undefined ? state : (existingCustomerColumns.includes('state') ? (c as any).state : null),
          postal_code !== undefined ? postal_code : (existingCustomerColumns.includes('postal_code') ? (c as any).postal_code : null),
        ].filter(Boolean);

        if (parts.length > 0) {
          customerUpdates.push(`customer_address = $${customerParamIndex++}`);
          customerParams.push(parts.join(', '));
        }
      }

      if (customerUpdates.length > 0) {
        customerParams.push(userId);
        const customerUpdateCol = existingCustomerColumns.includes('customer_date_modified') ? 'customer_date_modified' : (existingCustomerColumns.includes('updated_at') ? 'updated_at' : null);
        const updateQueryString = `UPDATE customer SET ${customerUpdates.join(', ')}${customerUpdateCol ? `, ${customerUpdateCol} = CURRENT_TIMESTAMP` : ''} WHERE user_id = $${customerParamIndex}`;
        await queryRunner.query(updateQueryString, customerParams);
      }

      // 3. Update company name if provided
      if (company_name) {
        const customerResult = await queryRunner.query('SELECT company_id FROM customer WHERE user_id = $1', [userId]);
        if (customerResult[0]?.company_id) {
          await queryRunner.query(
            'UPDATE company SET company_name = $1 WHERE company_id = $2',
            [company_name, customerResult[0].company_id]
          );
        }
      }

      await queryRunner.commitTransaction();
      return this.getCurrentCustomer(userId);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Update profile error:', error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
  /**
   * Check if email is already registered
   */
  async checkEmailAvailability(email: string): Promise<any> {
    if (!email) {
      throw new BadRequestException('Email is required');
    }

    const query = 'SELECT user_id FROM "user" WHERE LOWER(TRIM(email)) = $1 LIMIT 1';
    const result = await this.dataSource.query(query, [email.trim().toLowerCase()]);
    
    return {
      available: result.length === 0,
      registered: result.length > 0,
      message: result.length > 0 
        ? 'This email is already associated with a registered account. Please log in to your account to complete your purchase.' 
        : 'Email is available'
    };
  }
}
