import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SubscriptionSchedulerService } from './subscription-scheduler.service';
import { NotificationService } from '../../common/services/notification.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminSubscriptionsService {
  private readonly logger = new Logger(AdminSubscriptionsService.name);
  private tablesChecked = false;

  constructor(
    private dataSource: DataSource,
    private schedulerService: SubscriptionSchedulerService,
    private notificationService: NotificationService,
    private configService: ConfigService,
  ) { }

  /**
   * Ensure subscription_schedules table exists before querying
   */
  private async ensureTablesExist(): Promise<void> {
    if (this.tablesChecked) return;

    try {
      const schedulesCheck = await this.dataSource.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'subscription_schedules'
        ) as exists
      `);

      if (!schedulesCheck[0]?.exists) {
        await this.dataSource.query(`
          CREATE TABLE IF NOT EXISTS subscription_schedules (
            schedule_id SERIAL PRIMARY KEY,
            subscription_order_id INT NOT NULL UNIQUE,
            next_delivery_date TIMESTAMP,
            frequency_days INT NOT NULL,
            is_active BOOLEAN DEFAULT true,
            is_paused BOOLEAN DEFAULT false,
            paused_at TIMESTAMP,
            resume_date TIMESTAMP,
            last_generated_order_id INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await this.dataSource.query(`
          CREATE INDEX IF NOT EXISTS idx_subscription_schedules_order ON subscription_schedules(subscription_order_id)
        `);
        await this.dataSource.query(`
          CREATE INDEX IF NOT EXISTS idx_subscription_schedules_active ON subscription_schedules(is_active)
        `);
        this.logger.log('Created subscription_schedules table');
      }

      this.tablesChecked = true;
    } catch (error) {
      this.logger.error('Error ensuring subscription tables exist:', error);
    }
  }

  /**
   * List subscriptions (standing orders)
   */
  async listSubscriptions(filters: {
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    await this.ensureTablesExist();
    const { status, search, limit = 100, offset = 0 } = filters;

    let query = `
      SELECT 
        o.order_id,
        o.customer_id,
        o.standing_order,
        o.order_status,
        o.order_total,
        o.delivery_fee,
        o.date_added,
        o.date_modified,
        o.delivery_date_time,
        o.customer_order_name,
        o.order_comments,
        o.customer_company_name,
        o.customer_department_name,
        o.sent_to_customer,
        o.sent_to_customer_at,
        ss.next_delivery_date as schedule_next_date,
        c.firstname || ' ' || c.lastname as customer_name,
        co.company_name,
        (
          SELECT json_agg(json_build_object(
            'product_id', op.product_id,
            'product_name', p.product_name,
            'quantity', op.quantity,
            'price', op.price,
            'total', op.total,
            'options', (
              SELECT json_agg(json_build_object(
                'option_name', opo.option_name,
                'option_value', opo.option_value,
                'option_quantity', opo.option_quantity
              ))
              FROM order_product_option opo
              WHERE opo.order_product_id = op.order_product_id
            )
          ))
          FROM order_product op
          LEFT JOIN product p ON op.product_id = p.product_id
          WHERE op.order_id = o.order_id
        ) as products
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      LEFT JOIN company co ON c.company_id = co.company_id
      LEFT JOIN subscription_schedules ss ON o.order_id = ss.subscription_order_id
      WHERE o.standing_order != 0
    `;
    const params: any[] = [];
    let paramIndex = 1;

    // Filter by status (active/inactive)
    if (status === 'active') {
      query += ` AND o.order_status IN (1, 2, 4, 5, 7)`; // new, paid, awaiting_approval, completed, approved
    } else if (status === 'inactive') {
      query += ` AND o.order_status IN (0, 8)`; // cancelled, rejected
    }

    // Search filter
    if (search) {
      query += ` AND (
        c.firstname ILIKE $${paramIndex} OR
        c.lastname ILIKE $${paramIndex} OR
        co.company_name ILIKE $${paramIndex} OR
        o.order_id::text ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY o.date_added DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await this.dataSource.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) 
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      LEFT JOIN company co ON c.company_id = co.company_id
      WHERE o.standing_order != 0
    `;
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (status === 'active') {
      countQuery += ` AND o.order_status IN (1, 2, 4, 5, 7)`;
    } else if (status === 'inactive') {
      countQuery += ` AND o.order_status IN (0, 8)`;
    }

    if (search) {
      countQuery += ` AND (
        c.firstname ILIKE $${countParamIndex} OR
        c.lastname ILIKE $${countParamIndex} OR
        co.company_name ILIKE $${countParamIndex} OR
        o.order_id::text ILIKE $${countParamIndex}
      )`;
      countParams.push(`%${search}%`);
    }

    const countResult = await this.dataSource.query(countQuery, countParams);
    const count = parseInt(countResult[0].count);

    const now = new Date();
    const reminderThreshold = 3;

    const subscriptions = result.map((row: any) => {
      const weeks = Math.round(row.standing_order / 7) || 1;
      let reminder: string | null = null;
      const nextDate = row.schedule_next_date ? new Date(row.schedule_next_date) : (row.delivery_date_time ? new Date(row.delivery_date_time) : null);

      if (nextDate) {
        const timeDiff = nextDate.getTime() - now.getTime();
        const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
        if (daysDiff <= reminderThreshold && daysDiff >= -1) {
          reminder = `Next payment will be after ${weeks} week${weeks > 1 ? 's' : ''}`;
        }
      }

      return {
        ...row,
        status_name: row.order_status === 5 ? 'Completed' : (row.order_status === 1 ? 'New' : (row.order_status === 2 ? 'Paid' : (row.order_status === 4 ? 'Awaiting Approval' : (row.order_status === 7 ? 'Approved' : 'Updated')))),
        reminder,
      };
    });

    return { subscriptions, count };
  }

  /**
   * Get single subscription
   */
  async getSubscription(id: number) {
    await this.ensureTablesExist();
    const query = `
      SELECT 
        o.*,
        c.firstname || ' ' || c.lastname as customer_name,
        c.email as customer_email,
        c.telephone as customer_phone,
        co.company_name,
        ss.next_delivery_date as schedule_next_date,
        (
          SELECT json_agg(json_build_object(
            'product_id', op.product_id,
            'product_name', p.product_name,
            'quantity', op.quantity,
            'price', op.price,
            'total', op.total,
            'options', (
              SELECT json_agg(json_build_object(
                'option_name', opo.option_name,
                'option_value', opo.option_value,
                'option_quantity', opo.option_quantity,
                'option_price', opo.option_price
              ))
              FROM order_product_option opo
              WHERE opo.order_product_id = op.order_product_id
            )
          ))
          FROM order_product op
          LEFT JOIN product p ON op.product_id = p.product_id
          WHERE op.order_id = o.order_id
        ) as products
      FROM orders o
      LEFT JOIN customer c ON o.customer_id = c.customer_id
      LEFT JOIN company co ON c.company_id = co.company_id
      LEFT JOIN subscription_schedules ss ON o.order_id = ss.subscription_order_id
      WHERE o.order_id = $1 AND o.standing_order != 0
    `;

    const result = await this.dataSource.query(query, [Number(id)]);
    const subscription = result[0];

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    const now = new Date();
    const reminderThreshold = 3;
    let reminder: string | null = null;
    const nextDate = subscription.schedule_next_date ? new Date(subscription.schedule_next_date) : (subscription.delivery_date_time ? new Date(subscription.delivery_date_time) : null);

    if (nextDate) {
      const timeDiff = nextDate.getTime() - now.getTime();
      const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
      if (daysDiff <= reminderThreshold && daysDiff >= -1) {
        const weeks = Math.round(subscription.standing_order / 7) || 1;
        reminder = `Next payment will be after ${weeks} week${weeks > 1 ? 's' : ''}`;
      }
    }

    const formattedSubscription = {
      ...subscription,
      status_name: subscription.order_status === 5 ? 'Completed' : (subscription.order_status === 1 ? 'New' : (subscription.order_status === 2 ? 'Paid' : (subscription.order_status === 4 ? 'Awaiting Approval' : (subscription.order_status === 7 ? 'Approved' : 'Updated')))),
      reminder,
    };

    return { subscription: formattedSubscription };
  }

  /**
   * Cancel subscription (set status to cancelled)
   */
  async cancelSubscription(id: number, cancelComment?: string) {
    const query = `
      UPDATE orders 
      SET order_status = 0, 
          cancel_comment = $1,
          date_modified = CURRENT_TIMESTAMP
      WHERE order_id = $2 AND standing_order != 0
      RETURNING *
    `;

    const result = await this.dataSource.query(query, [
      cancelComment || 'Subscription cancelled',
      Number(id),
    ]);

    if (result.length === 0) {
      throw new NotFoundException('Subscription not found');
    }

    // Cancel future orders for this subscription
    await this.schedulerService.cancelFutureOrders(Number(id));

    // Send cancellation email to customer
    try {
      const infoQuery = `
        SELECT 
          c.email as customer_email,
          COALESCE(c.firstname || ' ' || c.lastname, u.username) as customer_name
        FROM orders o
        JOIN customer c ON o.customer_id = c.customer_id
        JOIN "user" u ON c.user_id = u.user_id
        WHERE o.order_id = $1
      `;
      const infoResult = await this.dataSource.query(infoQuery, [Number(id)]);
      const info = infoResult[0];
      if (info?.customer_email) {
        const companyName = this.configService.get<string>('COMPANY_NAME') || 'St Dreux Coffee';
        const contactNumber = this.configService.get<string>('COMPANY_PHONE') || '';
        const contactEmail = this.configService.get<string>('COMPANY_EMAIL') || '';
        const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
        const loginUrl = `${frontendUrl}/auth/login`;

        await this.notificationService.sendNotification({
          templateKey: 'subscription_cancelled',
          recipientEmail: info.customer_email,
          recipientName: info.customer_name || 'Customer',
          variables: {},
          customSubject: 'Subscription Cancelled – St Dreux Coffee',
          customBody: `
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
      <h1>${companyName}</h1>
    </div>
    <div class="content">
      <p>Dear ${info.customer_name || 'Customer'},</p>
      <p>This email confirms that your subscription has been cancelled.</p>
      <p>You will continue to have access to your account until the end of your current subscription period.</p>
      <p>If you wish to reactivate your subscription, please contact our admin team on ${contactNumber}.</p>
      <div style="text-align: center;">
        <a href="${loginUrl}" class="button" style="color: #ffffff !important; text-decoration: none; display: inline-block;">
          <span style="color: #ffffff !important; text-decoration: none;">Login Here</span>
        </a>
      </div>
      <p>If you have any questions, please contact us at ${contactNumber} or ${contactEmail}.</p>
      <p>Kind regards,<br/>${companyName} Team</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
          `,
        });
      }
    } catch (error) {
      this.logger.warn('Failed to send subscription cancelled email:', error);
    }

    return {
      subscription: result[0],
      message: 'Subscription cancelled successfully',
    };
  }

  /**
   * Activate subscription (set status to active)
   */
  async activateSubscription(id: number) {
    const query = `
      UPDATE orders 
      SET order_status = 7,
          cancel_comment = NULL,
          date_modified = CURRENT_TIMESTAMP
      WHERE order_id = $1 AND standing_order != 0
      RETURNING *
    `;

    const result = await this.dataSource.query(query, [Number(id)]);

    if (result.length === 0) {
      throw new NotFoundException('Subscription not found');
    }

    return {
      subscription: result[0],
      message: 'Subscription activated successfully',
    };
  }

  /**
   * Update subscription
   */
  async updateSubscription(
    id: number,
    updateData: {
      standing_order?: number;
      delivery_date_time?: string;
      order_comments?: string;
      customer_order_name?: string;
    },
  ) {
    const { standing_order, delivery_date_time, order_comments, customer_order_name } =
      updateData;

    const query = `
      UPDATE orders 
      SET 
        standing_order = COALESCE($1, standing_order),
        delivery_date_time = COALESCE($2, delivery_date_time),
        order_comments = COALESCE($3, order_comments),
        customer_order_name = COALESCE($4, customer_order_name),
        date_modified = CURRENT_TIMESTAMP
      WHERE order_id = $5 AND standing_order != 0
      RETURNING *
    `;

    const result = await this.dataSource.query(query, [
      standing_order,
      delivery_date_time,
      order_comments,
      customer_order_name,
      Number(id),
    ]);

    if (result.length === 0) {
      throw new NotFoundException('Subscription not found');
    }

    return {
      subscription: result[0],
      message: 'Subscription updated successfully',
    };
  }

  /**
   * Send subscription to customer (mark as sent)
   */
  async sendToCustomer(id: number) {
    const query = `
      UPDATE orders 
      SET 
        sent_to_customer = true,
        sent_to_customer_at = CURRENT_TIMESTAMP,
        date_modified = CURRENT_TIMESTAMP
      WHERE order_id = $1 AND standing_order != 0
      RETURNING *
    `;

    const result = await this.dataSource.query(query, [Number(id)]);

    if (result.length === 0) {
      throw new NotFoundException('Subscription not found');
    }

    return {
      subscription: result[0],
      message: 'Subscription marked as sent to customer',
    };
  }

  /**
   * Delete subscription
   */
  async deleteSubscription(id: number) {
    const query = 'DELETE FROM orders WHERE order_id = $1 AND standing_order != 0';
    const result = await this.dataSource.query(query, [Number(id)]);

    if (result.rowCount === 0) {
      throw new NotFoundException('Subscription not found');
    }

    return { message: 'Subscription deleted successfully' };
  }
}
