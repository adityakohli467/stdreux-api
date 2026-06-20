import { Injectable, Logger, BadRequestException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { XeroClient, Invoice, LineItem, Contact, Invoices, Phone, Contacts, CurrencyCode, Address } from 'xero-node';
import { DataSource } from 'typeorm';
import { TokenSet } from 'openid-client';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class AdminXeroService implements OnModuleInit {
  private readonly logger = new Logger(AdminXeroService.name);
  private xero: XeroClient;
  private initialized = false;

  constructor(
    private configService: ConfigService,
    private dataSource: DataSource,
  ) {
    this.xero = new XeroClient({
      clientId: this.configService.get<string>('XERO_CLIENT_ID') || '',
      clientSecret: this.configService.get<string>('XERO_CLIENT_SECRET') || '',
      redirectUris: [this.configService.get<string>('XERO_REDIRECT_URI') || ''],
      scopes: (this.configService.get<string>('XERO_SCOPES') || 'openid profile email offline_access accounting.invoices accounting.contacts accounting.settings accounting.transactions').split(' '),
    });
  }

  /**
   * Ensure the XeroClient's internal OpenID client is initialized.
   * This must be called before any token operations (refresh, setTokenSet).
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      try {
        await this.xero.initialize();
        this.initialized = true;
        this.logger.log('[Xero] Client initialized');
      } catch (error: any) {
        this.logger.error(`[Xero] Client initialization failed: ${error?.message}`);
        throw error;
      }
    }
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

      // Initialize the XeroClient OpenID client on startup
      await this.ensureInitialized();

      this.logger.log('Xero tables ensured');
    } catch (error) {
      this.logger.error('Failed to initialize Xero module:', error);
    }
  }

  /**
   * Get the Xero authorization URL for OAuth consent
   */
  async getAuthUrl(): Promise<string> {
    await this.ensureInitialized();
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
        this.logger.warn('[Xero] No stored tokens found — Xero not connected');
        return { connected: false };
      }

      await this.setTokensAndRefreshIfNeeded(tokens);
      await this.xero.updateTenants();

      const activeTenant = this.xero.tenants[0];
      return {
        connected: true,
        organisationName: activeTenant?.tenantName || 'Connected',
      };
    } catch (error: any) {
      this.logger.error(`[Xero] Connection check failed: ${error?.message || 'Unknown error'}`);
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
          c.customer_type,
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
      // If product has options: each option becomes a line item with option_quantity, option_price, option_total
      // If no options: use product quantity, price, total
      // GST rules: items in gst_free categories get taxType 'NONE', others get 'OUTPUT' (10% GST)
      // Delivery fee is always taxable (OUTPUT)
      // Retail customers: GST inclusive (prices include GST)
      // Wholesale customers: GST exclusive (GST added on top)
      const customerType = order.customer_type || '';
      const isWholesale = customerType.includes('Wholesale') || customerType.includes('Wholesaler');

      const lineItems: LineItem[] = [];
      for (const product of products) {
        // Check if this product's category is gst_free
        const catResult = await this.dataSource.query(
          `SELECT COALESCE(bool_or(c.gst_free), false) as is_gst_free
           FROM product_category pc JOIN category c ON pc.category_id = c.category_id
           WHERE pc.product_id = $1`, [product.product_id]);
        const isGstFree = catResult[0]?.is_gst_free === true;
        const taxType = isGstFree ? 'NONE' : 'OUTPUT';

        const productOptions = options.filter((o: any) => o.order_product_id === product.order_product_id);

        if (productOptions.length > 0) {
          // Product has options - create a line item per option
          for (const opt of productOptions) {
            const optQty = parseFloat(opt.option_quantity) || 1;
            const optPrice = parseFloat(opt.option_price) || 0;
            const description = `${product.product_name || product.catalog_name || 'Product'} - ${opt.option_name}: ${opt.option_value}`;

            lineItems.push({
              description,
              quantity: optQty,
              unitAmount: optPrice,
              accountCode: '200',
              taxType,
            });
          }
        } else {
          // No options - use product-level data
          const quantity = parseFloat(product.quantity) || 1;
          const total = parseFloat(product.total) || 0;
          const unitPrice = quantity > 0 ? total / quantity : total;
          const description = product.product_name || product.catalog_name || 'Product';

          lineItems.push({
            description,
            quantity,
            unitAmount: unitPrice,
            accountCode: '200',
            taxType,
          });
        }
      }

      // Add delivery fee as line item if present (always taxable)
      if (order.delivery_fee && parseFloat(order.delivery_fee) > 0) {
        lineItems.push({
          description: 'Delivery Fee',
          quantity: 1,
          unitAmount: parseFloat(order.delivery_fee),
          accountCode: '200',
          taxType: 'OUTPUT',
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
      // Paid: AUTHORISED (required before payment can be applied)
      // Unpaid: SUBMITTED (goes to "Awaiting Approval" in Xero)
      const invoiceStatus = isPaid ? Invoice.StatusEnum.AUTHORISED : Invoice.StatusEnum.SUBMITTED;

      // Create the invoice in Xero
      // Retail: prices are inclusive of GST (Inclusive)
      // Wholesale: prices are exclusive of GST (Exclusive)
      const lineAmountTypes = isWholesale ? 'Exclusive' : 'Inclusive';

      const invoice: Invoice = {
        type: Invoice.TypeEnum.ACCREC, // Sales invoice
        contact: { contactID: contact.contactID },
        lineItems,
        lineAmountTypes: lineAmountTypes as any,
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

      // If order is paid, create a payment in Xero to mark invoice as paid
      // Step 1: Invoice was created as AUTHORISED
      // Step 2: Apply payment to move it to PAID status
      if (isPaid && createdInvoice.invoiceID) {
        try {
          const invoiceTotal = createdInvoice.total || createdInvoice.amountDue || parseFloat(order.order_total || 0);
          const paymentDate = order.payment_date
            ? new Date(order.payment_date).toISOString().split('T')[0]
            : new Date().toISOString().split('T')[0];

          this.logger.log(`[Xero Payment] Attempting to record payment: invoice=${createdInvoice.invoiceID}, amount=${invoiceTotal}, date=${paymentDate}`);

          // Find a bank account to apply payment against
          const accountsResponse = await this.xero.accountingApi.getAccounts(
            tenantId, undefined, 'Type=="BANK"'
          );
          const bankAccounts = accountsResponse.body.accounts;

          if (!bankAccounts || bankAccounts.length === 0) {
            this.logger.error(`[Xero Payment] No bank accounts found in Xero. Cannot record payment.`);
          } else {
            const bankAccount = bankAccounts[0];
            this.logger.log(`[Xero Payment] Using bank: ${bankAccount.name} (ID: ${bankAccount.accountID}, Code: ${bankAccount.code})`);

            // Use createPayment (singular) with Payment object directly
            const payment: any = {
              invoice: { invoiceID: createdInvoice.invoiceID },
              account: { accountID: bankAccount.accountID },
              amount: invoiceTotal,
              date: paymentDate,
            };

            this.logger.log(`[Xero Payment] Payload: ${JSON.stringify(payment)}`);

            const paymentResponse = await this.xero.accountingApi.createPayment(tenantId, payment);
            const createdPayment = (paymentResponse.body as any)?.payments?.[0] || paymentResponse.body;
            this.logger.log(`[Xero Payment] Full response: ${JSON.stringify(paymentResponse.body)}`);
            if (createdPayment?.paymentID) {
              this.logger.log(`[Xero Payment] SUCCESS - PaymentID: ${createdPayment.paymentID} for invoice ${createdInvoice.invoiceNumber}`);
            } else {
              this.logger.warn(`[Xero Payment] Payment created but no paymentID in response`);
            }
          }
        } catch (paymentError: any) {
          this.logger.error(`[Xero Payment] FAILED for order #${orderId}`);
          this.logger.error(`[Xero Payment] Error message: ${paymentError?.message || 'none'}`);
          this.logger.error(`[Xero Payment] Error string: ${String(paymentError)}`);
          try {
            this.logger.error(`[Xero Payment] Full error: ${JSON.stringify(paymentError, Object.getOwnPropertyNames(paymentError))}`);
          } catch (e) {
            this.logger.error(`[Xero Payment] Could not stringify error`);
          }
          if (paymentError?.response?.body) {
            this.logger.error(`[Xero Payment] Xero response body: ${JSON.stringify(paymentError.response.body)}`);
          }
          if (paymentError?.body) {
            this.logger.error(`[Xero Payment] Error body: ${JSON.stringify(paymentError.body)}`);
          }
        }
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

    const deliveryAddress = order.delivery_address || order.customer_address || '';

    if (existingContacts && existingContacts.length > 0) {
      const existing = existingContacts[0];

      // Update existing contact with delivery address if available
      if (deliveryAddress && existing.contactID) {
        try {
          const updatedContact: Contact = {
            contactID: existing.contactID,
            name: existing.name,
            addresses: [
              {
                addressType: Address.AddressTypeEnum.STREET,
                addressLine1: deliveryAddress,
              },
            ],
          };
          const contacts: Contacts = { contacts: [updatedContact] };
          await this.xero.accountingApi.updateContact(tenantId, existing.contactID, contacts);
        } catch (e) {
          this.logger.warn(`Failed to update Xero contact address: ${e?.message}`);
        }
      }
      return existing;
    }

    // Create new contact
    const email = order.customer_email || order.email || order.account_email;
    const phone = order.customer_telephone || order.telephone;

    const addresses: Address[] = [];
    if (deliveryAddress) {
      addresses.push({
        addressType: Address.AddressTypeEnum.STREET,
        addressLine1: deliveryAddress,
      });
    }

    const newContact: Contact = {
      name,
      emailAddress: email || undefined,
      phones: phone ? [{ phoneType: Phone.PhoneTypeEnum.DEFAULT, phoneNumber: phone }] : undefined,
      addresses: addresses.length > 0 ? addresses : undefined,
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
   * Set tokens on the client and refresh if expired.
   * Ensures client is initialized, retries once on transient failures.
   */
  private async setTokensAndRefreshIfNeeded(tokenSet: TokenSet): Promise<void> {
    await this.ensureInitialized();
    this.xero.setTokenSet(tokenSet);

    if (tokenSet.expired()) {
      if (!tokenSet.refresh_token) {
        throw new BadRequestException('Xero token expired and no refresh token available. Please reconnect Xero.');
      }

      // Try refreshing with one retry for transient failures
      let lastError: any;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const newTokenSet = await this.xero.refreshToken();
          // Save the refreshed tokens
          const tenantResult = await this.dataSource.query(`SELECT tenant_id FROM xero_tokens WHERE id = 1`);
          const tenantId = tenantResult[0]?.tenant_id || '';
          await this.saveTokens(newTokenSet, tenantId);
          this.logger.log(`[Xero] Token refreshed successfully (attempt ${attempt + 1})`);
          return;
        } catch (error: any) {
          lastError = error;
          this.logger.warn(`[Xero] Token refresh attempt ${attempt + 1} failed: ${error?.message}`);
          // If Xero explicitly says the refresh token is invalid/revoked, don't retry
          if (error?.response?.statusCode === 400 && error?.response?.body?.error === 'invalid_grant') {
            this.logger.error('[Xero] Refresh token has been revoked. Manual reconnection required.');
            throw new BadRequestException('Xero refresh token revoked. Please reconnect Xero.');
          }
          // Wait 2 seconds before retry
          if (attempt === 0) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }
      throw lastError;
    }
  }

  /**
   * Get the Xero webhook signing key from environment
   */
  getWebhookKey(): string | null {
    return this.configService.get<string>('XERO_WEBHOOK_KEY') || null;
  }

  /**
   * Handle a Xero invoice webhook event.
   * Fetches the invoice from Xero and if it's PAID, marks the corresponding order as paid.
   */
  async handleXeroInvoiceWebhook(
    xeroInvoiceId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      // Find matching order from our sync table
      const syncResult = await this.dataSource.query(
        `SELECT order_id FROM xero_invoice_sync WHERE xero_invoice_id = $1`,
        [xeroInvoiceId],
      );

      if (syncResult.length === 0) {
        this.logger.log(
          `[Xero Webhook] No synced order found for Xero invoice ${xeroInvoiceId} — skipping`,
        );
        return;
      }

      const orderId = syncResult[0].order_id;

      // Check if order is already paid
      const orderResult = await this.dataSource.query(
        `SELECT payment_status, order_status FROM orders WHERE order_id = $1`,
        [orderId],
      );

      if (orderResult.length === 0) {
        this.logger.warn(`[Xero Webhook] Order ${orderId} not found`);
        return;
      }

      const order = orderResult[0];
      if (
        order.payment_status === 'succeeded' ||
        order.payment_status === 'paid' ||
        order.order_status === 2
      ) {
        this.logger.log(
          `[Xero Webhook] Order ${orderId} already paid — skipping`,
        );
        return;
      }

      // Fetch invoice from Xero API to check its status
      const tokens = await this.getStoredTokens();
      if (!tokens) {
        this.logger.error('[Xero Webhook] Xero not connected — cannot fetch invoice');
        return;
      }

      await this.setTokensAndRefreshIfNeeded(tokens);
      await this.xero.updateTenants();

      const activeTenantId = tenantId || this.xero.tenants[0]?.tenantId;
      if (!activeTenantId) {
        this.logger.error('[Xero Webhook] No tenant available');
        return;
      }

      const invoiceResponse = await this.xero.accountingApi.getInvoice(
        activeTenantId,
        xeroInvoiceId,
      );
      const invoice = invoiceResponse.body.invoices?.[0];

      if (!invoice) {
        this.logger.warn(
          `[Xero Webhook] Could not fetch invoice ${xeroInvoiceId} from Xero`,
        );
        return;
      }

      this.logger.log(
        `[Xero Webhook] Invoice ${invoice.invoiceNumber} status: ${invoice.status}`,
      );

      // Only mark as paid if invoice status is PAID in Xero
      if (invoice.status === Invoice.StatusEnum.PAID) {
        await this.dataSource.query(
          `UPDATE orders 
           SET order_status = 2,
               payment_status = 'succeeded',
               payment_date = COALESCE(payment_date, CURRENT_TIMESTAMP),
               date_modified = CURRENT_TIMESTAMP
           WHERE order_id = $1`,
          [orderId],
        );

        this.logger.log(
          `[Xero Webhook] Order #${orderId} marked as paid (Xero invoice ${invoice.invoiceNumber} is PAID)`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `[Xero Webhook] Failed to process invoice ${xeroInvoiceId}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Proactively refresh Xero token daily to keep the connection alive.
   * Xero access tokens expire after 30 minutes, refresh tokens after 60 days of inactivity.
   * Running daily ensures the refresh token stays active.
   * NestJS @Cron runs in-process — no external cron service needed.
   */
  @Cron('0 4 * * *', { name: 'xero-token-refresh' })
  async handleScheduledTokenRefresh(): Promise<void> {
    try {
      const tokens = await this.getStoredTokens();
      if (!tokens || !tokens.refresh_token) {
        return; // No connection, nothing to refresh
      }

      await this.ensureInitialized();
      this.xero.setTokenSet(tokens);
      const newTokenSet = await this.xero.refreshToken();

      const tenantResult = await this.dataSource.query(`SELECT tenant_id FROM xero_tokens WHERE id = 1`);
      const tenantId = tenantResult[0]?.tenant_id || '';
      await this.saveTokens(newTokenSet, tenantId);

      this.logger.log('[Xero] Token proactively refreshed via daily cron');
    } catch (error: any) {
      this.logger.error(`[Xero] Scheduled token refresh failed: ${error?.message}`);
    }
  }
}
