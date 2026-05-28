import { Injectable, Logger, BadRequestException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { XeroClient, Invoice, LineItem, Contact, Invoices, Phone, Contacts, CurrencyCode } from 'xero-node';
import { DataSource } from 'typeorm';
import { TokenSet } from 'openid-client';

@Injectable()
export class AdminXeroService implements OnModuleInit {
  private readonly logger = new Logger(AdminXeroService.name);
  private xero: XeroClient;

  constructor(
    private configService: ConfigService,
    private dataSource: DataSource,
  ) {
    this.xero = new XeroClient({
      clientId: this.configService.get<string>('XERO_CLIENT_ID') || '',
      clientSecret: this.configService.get<string>('XERO_CLIENT_SECRET') || '',
      redirectUris: [this.configService.get<string>('XERO_REDIRECT_URI') || ''],
      scopes: (this.configService.get<string>('XERO_SCOPES') || 'openid profile email offline_access accounting.invoices accounting.contacts accounting.settings').split(' '),
    });
  }

  async onModuleInit() {
    try {
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS xero_tokens (
          id INTEGER PRIMARY KEY DEFAULT 1,
          tenant_id VARCHAR(255) NOT NULL,
          token_data JSONB NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT single_row CHECK (id = 1)
        )
      `);
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS xero_invoice_sync (
          id SERIAL PRIMARY KEY,
          order_id INTEGER NOT NULL UNIQUE,
          xero_invoice_id VARCHAR(255) NOT NULL,
          xero_invoice_number VARCHAR(100),
          xero_contact_id VARCHAR(255),
          synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS idx_xero_invoice_sync_order_id ON xero_invoice_sync(order_id)
      `);
      this.logger.log('Xero tables ensured');
    } catch (error) {
      this.logger.error('Failed to create Xero tables:', error);
    }
  }

  /**
   * Get the Xero authorization URL for OAuth consent
   */
  async getAuthUrl(): Promise<string> {
    const consentUrl = await this.xero.buildConsentUrl();
    return consentUrl;
  }

  /**
   * Handle the OAuth callback and exchange code for tokens
   */
  async handleCallback(url: string): Promise<{ success: boolean; tenantId: string }> {
    const tokenSet = await this.xero.apiCallback(url);
    await this.xero.updateTenants();

    const activeTenant = this.xero.tenants[0];
    if (!activeTenant) {
      throw new BadRequestException('No Xero organisation connected');
    }

    // Store tokens in database
    await this.saveTokens(tokenSet, activeTenant.tenantId);

    return {
      success: true,
      tenantId: activeTenant.tenantId,
    };
  }

  /**
   * Check if Xero is connected (tokens exist and are valid)
   */
  async isConnected(): Promise<{ connected: boolean; organisationName?: string }> {
    try {
      const tokens = await this.getStoredTokens();
      if (!tokens) {
        return { connected: false };
      }

      await this.setTokensAndRefreshIfNeeded(tokens);
      await this.xero.updateTenants();

      const activeTenant = this.xero.tenants[0];
      return {
        connected: true,
        organisationName: activeTenant?.tenantName || 'Connected',
      };
    } catch {
      return { connected: false };
    }
  }

  /**
   * Disconnect Xero (remove stored tokens)
   */
  async disconnect(): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM xero_tokens WHERE id = 1`,
    );
  }

  /**
   * Remove sync record for an order (allows re-syncing)
   */
  async removeSyncRecord(orderId: number): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM xero_invoice_sync WHERE order_id = $1`,
      [orderId],
    );
  }

  /**
   * Create an invoice in Xero for an order
   */
  async createInvoiceForOrder(orderId: number): Promise<{ invoiceId: string; invoiceNumber: string }> {
    try {
      // Ensure we have valid tokens
      const tokens = await this.getStoredTokens();
      if (!tokens) {
        throw new BadRequestException('Xero is not connected. Please connect Xero first.');
      }
      await this.setTokensAndRefreshIfNeeded(tokens);
      await this.xero.updateTenants();

      const tenantId = this.xero.tenants[0]?.tenantId;
      if (!tenantId) {
        throw new BadRequestException('No Xero organisation found');
      }

      // Get order details with products
      const orderQuery = `
        SELECT 
          o.*,
          c.firstname as customer_firstname,
          c.lastname as customer_lastname,
          c.email as customer_email,
          c.telephone as customer_telephone,
          c.customer_address,
          co.company_name
        FROM orders o
        LEFT JOIN customer c ON o.customer_id = c.customer_id
        LEFT JOIN company co ON c.company_id = co.company_id
        WHERE o.order_id = $1
      `;
      const orderResult = await this.dataSource.query(orderQuery, [orderId]);
      const order = orderResult[0];

      if (!order) {
        throw new BadRequestException('Order not found');
      }

      // Check if already synced
      const existingSync = await this.dataSource.query(
        `SELECT xero_invoice_id FROM xero_invoice_sync WHERE order_id = $1`,
        [orderId],
      );
      if (existingSync.length > 0) {
        throw new BadRequestException(`Order #${orderId} already synced to Xero (Invoice: ${existingSync[0].xero_invoice_id})`);
      }

      // Get order products
      const productsQuery = `
        SELECT op.*, p.product_name as catalog_name
        FROM order_product op
        LEFT JOIN product p ON op.product_id = p.product_id
        WHERE op.order_id = $1
        ORDER BY op.sort_order
      `;
      const products = await this.dataSource.query(productsQuery, [orderId]);

      // Get order product options with pricing
      const optionsQuery = `
        SELECT opo.*
        FROM order_product_option opo
        INNER JOIN order_product op ON opo.order_product_id = op.order_product_id
        WHERE op.order_id = $1
      `;
      const options = await this.dataSource.query(optionsQuery, [orderId]);

      // Create or find contact in Xero
      const contactName = order.company_name || `${order.customer_firstname || order.firstname || ''} ${order.customer_lastname || order.lastname || ''}`.trim() || `Customer ${order.customer_id}`;
      const contact = await this.findOrCreateContact(tenantId, contactName, order);

      // Build line items
      const lineItems: LineItem[] = products.map((product: any) => {
        const productOptions = options.filter((o: any) => o.order_product_id === product.order_product_id);

        // Calculate total from options if available, otherwise use product total/price
        let total = 0;
        let quantity = product.quantity || 1;
        if (productOptions.length > 0) {
          // Sum option_price * option_quantity for all options
          total = productOptions.reduce((sum: number, opt: any) => {
            return sum + (parseFloat(opt.option_price || 0) * (opt.option_quantity || 1));
          }, 0);
        } else {
          total = parseFloat(product.total) || (parseFloat(product.price) || 0) * quantity;
        }
        const unitPrice = quantity > 0 ? total / quantity : total;

        // Build description with options
        const optionDesc = productOptions.map((o: any) => `${o.option_name}: ${o.option_value}`).join(', ');
        const description = optionDesc
          ? `${product.product_name || product.catalog_name || 'Product'} (${optionDesc})`
          : (product.product_name || product.catalog_name || 'Product');

        return {
          description,
          quantity,
          unitAmount: unitPrice,
          accountCode: '200',
          taxType: 'NONE',
        };
      });

      // Add delivery fee as line item if present
      if (order.delivery_fee && parseFloat(order.delivery_fee) > 0) {
        lineItems.push({
          description: 'Delivery Fee',
          quantity: 1,
          unitAmount: parseFloat(order.delivery_fee),
          accountCode: '200',
          taxType: 'NONE',
        });
      }

      // Apply coupon discount as negative line item
      if (order.coupon_discount && parseFloat(order.coupon_discount) > 0) {
        lineItems.push({
          description: 'Discount',
          quantity: 1,
          unitAmount: -parseFloat(order.coupon_discount),
          accountCode: '200',
          taxType: 'NONE',
        });
      }

      // Determine invoice status based on payment
      const isPaid = order.payment_status === 'succeeded' || order.payment_status === 'paid' || String(order.payment_status) === '1' || order.order_status === 2;
      const invoiceStatus = isPaid ? Invoice.StatusEnum.AUTHORISED : Invoice.StatusEnum.SUBMITTED;

      // Create the invoice in Xero
      const invoice: Invoice = {
        type: Invoice.TypeEnum.ACCREC, // Sales invoice
        contact: { contactID: contact.contactID },
        lineItems,
        date: order.payment_date ? new Date(order.payment_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        dueDate: order.payment_date ? new Date(order.payment_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        reference: `Order #${orderId}`,
        status: invoiceStatus,
        currencyCode: CurrencyCode.AUD,
      };

      const invoices: Invoices = { invoices: [invoice] };
      const response = await this.xero.accountingApi.createInvoices(tenantId, invoices);
      const createdInvoice = response.body.invoices?.[0];

      if (!createdInvoice?.invoiceID) {
        throw new BadRequestException('Failed to create invoice in Xero');
      }

      // Record the sync
      await this.dataSource.query(
        `INSERT INTO xero_invoice_sync (order_id, xero_invoice_id, xero_invoice_number, xero_contact_id, synced_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
        [orderId, createdInvoice.invoiceID, createdInvoice.invoiceNumber, contact.contactID],
      );

      this.logger.log(`Xero invoice created for order #${orderId}: ${createdInvoice.invoiceNumber}`);

      return {
        invoiceId: createdInvoice.invoiceID,
        invoiceNumber: createdInvoice.invoiceNumber || '',
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      const errorMsg = error?.response?.body?.Message || error?.body?.Message || error?.message || 'Unknown error';
      this.logger.error(`[Xero] Failed to create invoice for order #${orderId}: ${errorMsg}`, error?.stack);
      throw new BadRequestException(`Xero sync failed: ${errorMsg}`);
    }
  }

  /**
   * Find or create a contact in Xero
   */
  private async findOrCreateContact(tenantId: string, name: string, order: any): Promise<Contact> {
    // Search for existing contact
    const searchResponse = await this.xero.accountingApi.getContacts(tenantId, undefined, `Name=="${name}"`);
    const existingContacts = searchResponse.body.contacts;

    if (existingContacts && existingContacts.length > 0) {
      return existingContacts[0];
    }

    // Create new contact
    const email = order.customer_email || order.email || order.account_email;
    const phone = order.customer_telephone || order.telephone;

    const newContact: Contact = {
      name,
      emailAddress: email || undefined,
      phones: phone ? [{ phoneType: Phone.PhoneTypeEnum.DEFAULT, phoneNumber: phone }] : undefined,
    };

    const contacts: Contacts = { contacts: [newContact] };
    const createResponse = await this.xero.accountingApi.createContacts(tenantId, contacts);
    const created = createResponse.body.contacts?.[0];

    if (!created?.contactID) {
      throw new BadRequestException('Failed to create contact in Xero');
    }

    return created;
  }

  /**
   * Store tokens in the database
   */
  private async saveTokens(tokenSet: TokenSet, tenantId: string): Promise<void> {
    const tokenData = JSON.stringify({
      access_token: tokenSet.access_token,
      refresh_token: tokenSet.refresh_token,
      expires_at: tokenSet.expires_at,
      id_token: tokenSet.id_token,
      token_type: tokenSet.token_type,
      scope: tokenSet.scope,
    });

    await this.dataSource.query(
      `INSERT INTO xero_tokens (id, tenant_id, token_data, updated_at)
       VALUES (1, $1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET tenant_id = $1, token_data = $2, updated_at = CURRENT_TIMESTAMP`,
      [tenantId, tokenData],
    );
  }

  /**
   * Get stored tokens from the database
   */
  private async getStoredTokens(): Promise<TokenSet | null> {
    const result = await this.dataSource.query(
      `SELECT token_data FROM xero_tokens WHERE id = 1`,
    );
    if (result.length === 0) {
      return null;
    }
    const data = typeof result[0].token_data === 'string' ? JSON.parse(result[0].token_data) : result[0].token_data;
    return new TokenSet(data);
  }

  /**
   * Set tokens on the client and refresh if expired
   */
  private async setTokensAndRefreshIfNeeded(tokenSet: TokenSet): Promise<void> {
    this.xero.setTokenSet(tokenSet);

    if (tokenSet.expired()) {
      if (!tokenSet.refresh_token) {
        // No refresh token available — user needs to reconnect
        await this.dataSource.query(`DELETE FROM xero_tokens WHERE id = 1`);
        throw new BadRequestException('Xero token expired and no refresh token available. Please reconnect Xero.');
      }
      const newTokenSet = await this.xero.refreshToken();
      // Save the refreshed tokens
      const tenantResult = await this.dataSource.query(`SELECT tenant_id FROM xero_tokens WHERE id = 1`);
      const tenantId = tenantResult[0]?.tenant_id || '';
      await this.saveTokens(newTokenSet, tenantId);
    }
  }
}
