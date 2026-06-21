import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EmailService } from '../../common/services/email.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StoreNewsletterService {
  private readonly logger = new Logger(StoreNewsletterService.name);

  constructor(
    private dataSource: DataSource,
    private emailService: EmailService,
    private configService: ConfigService,
  ) {}

  /**
   * Subscribe to newsletter
   */
  async subscribe(data: { email: string }, ipAddress?: string, userAgent?: string) {
    const { email } = data;

    // Validation
    if (!email) {
      throw new BadRequestException('Email is required');
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new BadRequestException('Invalid email format');
    }

    // Check if email already exists
    const checkQuery = `
      SELECT subscription_id, status 
      FROM newsletter_subscriptions 
      WHERE email = $1
    `;
    const checkResult = await this.dataSource.query(checkQuery, [email.toLowerCase().trim()]);

    if (checkResult.length > 0) {
      const existing = checkResult[0];

      // If already subscribed and active, return success
      if (existing.status === 'active') {
        return {
          message: 'You are already subscribed to our newsletter',
          subscribed: true,
        };
      }

      // If unsubscribed, reactivate
      if (existing.status === 'unsubscribed') {
        const updateQuery = `
          UPDATE newsletter_subscriptions
          SET status = 'active',
              subscribed_at = CURRENT_TIMESTAMP,
              unsubscribed_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE subscription_id = $1
          RETURNING *
        `;
        await this.dataSource.query(updateQuery, [existing.subscription_id]);

        // Send welcome back email
        await this.sendWelcomeEmail(email);

        return {
          message: 'Successfully resubscribed to our newsletter',
          subscribed: true,
        };
      }
    }

    // Insert new subscription
    const insertQuery = `
      INSERT INTO newsletter_subscriptions (
        email,
        status,
        source,
        ip_address,
        user_agent
      ) VALUES ($1, 'active', 'website', $2, $3)
      RETURNING *
    `;

    try {
      const result = await this.dataSource.query(insertQuery, [
        email.toLowerCase().trim(),
        ipAddress || null,
        userAgent || null,
      ]);

      // Send welcome email
      await this.sendWelcomeEmail(email);

      // Send notification email to admin
      await this.sendAdminNotification(email);

      return {
        message: 'Successfully subscribed to our newsletter',
        subscribed: true,
      };
    } catch (error: any) {
      // Handle unique constraint violation (race condition)
      if (error.code === '23505') {
        return {
          message: 'You are already subscribed to our newsletter',
          subscribed: true,
        };
      }
      throw error;
    }
  }

  /**
   * Send welcome email to subscriber
   */
  private async sendWelcomeEmail(email: string): Promise<void> {
    try {
      const companyName = this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee';
      const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3006';
      const contactNumber = this.configService.get<string>('COMPANY_PHONE') || '';
      const contactEmail = this.configService.get<string>('COMPANY_EMAIL') || '';

      const emailHtml = `
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
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
    .button { display: inline-block; padding: 12px 30px; background-color: #2952E6; color: #ffffff !important; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    ul { margin: 0 0 16px 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${companyName}</h1>
    </div>
    <div class="content">
      <p>Dear Subscriber,</p>
      <p>Welcome to ${companyName} – your newsletter subscription is confirmed.</p>
      <p>You’ll now receive updates about:</p>
      <ul>
        <li>New coffee blends and products</li>
        <li>Special offers and promotions</li>
        <li>Brewing tips and recipes</li>
        <li>Company news and events</li>
      </ul>
      <p>We’re excited to share our passion for great coffee with you!</p>
      <p style="margin-top: 30px; text-align: center;">
        <a href="${frontendUrl}" class="button" style="color: #ffffff !important; text-decoration: none; display: inline-block;">
          <span style="color: #ffffff !important; text-decoration: none;">Visit Our Shop</span>
        </a>
      </p>
      <p>If you have any questions, please contact us at ${contactNumber} ${contactEmail}.</p>
      <p>Kind regards,<br/>${companyName} Team</p>
    </div>
    <div class="footer">
      <p>If you did not subscribe to this newsletter, please ignore this email.</p>
      <p><a href="${frontendUrl}/unsubscribe?email=${encodeURIComponent(email)}" style="color: #666;">Unsubscribe</a></p>
      <p>&copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
      `;

      await this.emailService.sendEmail({
        to: email,
        subject: `Welcome to ${companyName} – Newsletter Subscription Confirmed`,
        html: emailHtml,
      });
    } catch (error) {
      this.logger.error('Failed to send welcome email:', error);
      // Don't throw - subscription should still succeed even if email fails
    }
  }

  /**
   * Send notification email to admin
   */
  private async sendAdminNotification(email: string): Promise<void> {
    try {
      const adminEmail =
        this.configService.get<string>('ADMIN_EMAIL') ||
        this.configService.get<string>('FROM_EMAIL') ||
        'info@stdreux.com.au';
      const companyName = this.configService.get<string>('COMPANY_NAME') || 'St. Dreux Coffee';

      const emailHtml = `
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
    .field { margin-bottom: 15px; }
    .label { font-weight: bold; color: #666; }
    .value { color: #333; margin-top: 5px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>New Newsletter Subscription</h1>
    </div>
    <div class="content">
      <p>A new subscriber has joined the ${companyName} newsletter:</p>
      <div class="field">
        <div class="label">Email:</div>
        <div class="value">${email}</div>
      </div>
      <div class="field">
        <div class="label">Subscribed At:</div>
        <div class="value">${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })}</div>
      </div>
    </div>
  </div>
</body>
</html>
      `;

      await this.emailService.sendEmail({
        to: adminEmail,
        subject: `New Newsletter Subscription: ${email}`,
        html: emailHtml,
      });
    } catch (error) {
      this.logger.error('Failed to send admin notification:', error);
      // Don't throw - subscription should still succeed even if notification fails
    }
  }
}
