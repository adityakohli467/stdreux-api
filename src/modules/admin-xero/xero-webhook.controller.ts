import {
  Controller,
  Post,
  Req,
  Res,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdminXeroService } from './admin-xero.service';
import * as crypto from 'crypto';

@ApiTags('Xero Webhooks')
@Controller('webhooks/xero')
export class XeroWebhookController {
  private readonly logger = new Logger(XeroWebhookController.name);

  constructor(private readonly xeroService: AdminXeroService) {}

  /**
   * Xero webhook endpoint for invoice events.
   * Verifies HMAC-SHA256 signature and processes invoice payment updates.
   *
   * Xero requires:
   * - 2xx response for valid signatures
   * - 401 response for invalid signatures
   * - Response within 5 seconds
   * - No cookies in response headers
   */
  @Post()
  @ApiOperation({ summary: 'Handle Xero webhook events' })
  async handleWebhook(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const signature = req.headers['x-xero-signature'] as string;
    const rawBody = (req as any).rawBody;

    if (!signature || !rawBody) {
      this.logger.warn('[Xero Webhook] Missing signature or body');
      return res.status(401).send();
    }

    // Verify HMAC-SHA256 signature
    const webhookKey = this.xeroService.getWebhookKey();
    if (!webhookKey) {
      this.logger.error('[Xero Webhook] XERO_WEBHOOK_KEY not configured');
      return res.status(401).send();
    }

    const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expectedSignature = crypto
      .createHmac('sha256', webhookKey)
      .update(payload)
      .digest('base64');

    if (signature !== expectedSignature) {
      this.logger.warn('[Xero Webhook] Invalid signature');
      return res.status(401).send();
    }

    // Signature valid — respond immediately, then process asynchronously
    res.status(200).send();

    // Process events in the background (Xero requires response within 5 seconds)
    try {
      const body = JSON.parse(payload);
      const events = body.events || [];

      this.logger.log(`[Xero Webhook] Received ${events.length} event(s)`);

      for (const event of events) {
        this.logger.log(
          `[Xero Webhook] Event: category=${event.eventCategory}, type=${event.eventType}, resourceId=${event.resourceId}, tenantId=${event.tenantId}`,
        );

        if (
          event.eventCategory === 'INVOICE' &&
          event.eventType?.toUpperCase() === 'UPDATE' &&
          event.resourceId
        ) {
          await this.xeroService.handleXeroInvoiceWebhook(
            event.resourceId,
            event.tenantId,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(
        `[Xero Webhook] Error processing events: ${error.message}`,
        error.stack,
      );
    }
  }
}
