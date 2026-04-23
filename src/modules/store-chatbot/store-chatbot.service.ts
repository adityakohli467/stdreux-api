import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import Groq from 'groq-sdk';
import { EmailService } from '../../common/services/email.service';
import { NotificationService } from '../../common/services/notification.service';

interface ProductSuggestion {
  product_id: number;
  product_name: string;
  quantity: number;
  reason: string;
  product_price: number;
  product_image?: string;
  estimated_total: number;
  options?: Array<{
    option_id: number;
    option_value_id: number;
    option_name: string;
    option_value: string;
    option_price: string;
    option_price_prefix: string;
  }>;
}

export interface ChatResponse {
  reply: string;
  suggestions: ProductSuggestion[] | null;
  canAddToCart: boolean;
  followUpQuestions?: string[];
}

interface EmailQuoteRequest {
  suggestions: Array<{
    product_id: number;
    product_name: string;
    quantity: number;
    product_price: number;
    estimated_total: number;
    options?: Array<{
      option_id: number;
      option_value_id: number;
      option_name: string;
      option_value: string;
    }>;
  }>;
  customerEmail: string;
  customerName?: string;
  eventDetails?: string;
}

@Injectable()
export class StoreChatbotService {
  private readonly logger = new Logger(StoreChatbotService.name);
  private groq: Groq | null = null;
  private catalogCache: { data: string; expiry: number } | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    private dataSource: DataSource,
    private configService: ConfigService,
    private jwtService: JwtService,
    private emailService: EmailService,
    private notificationService: NotificationService,
  ) {
    const groqKey = this.configService.get<string>('GROQ_API_KEY') || process.env.GROQ_API_KEY;
    this.logger.log(`GROQ_API_KEY present: ${!!groqKey}, length: ${groqKey?.length || 0}`);
    if (groqKey) {
      this.groq = new Groq({ apiKey: groqKey });
      this.logger.log('Groq AI initialized');
    } else {
      this.logger.warn('GROQ_API_KEY not set — chatbot will be unavailable');
    }
  }

  /**
   * Extract user ID from JWT token
   */
  private extractUserIdFromToken(authHeader?: string): number | null {
    try {
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const decoded = this.jwtService.decode(token) as any;
        return decoded?.user_id || decoded?.id || null;
      }
    } catch {
      // Token invalid or not provided
    }
    return null;
  }

  /**
   * Build product catalog string for LLM context
   */
  private async buildProductCatalog(): Promise<string> {
    const now = Date.now();
    if (this.catalogCache && now < this.catalogCache.expiry) {
      return this.catalogCache.data;
    }

    // Fetch active, visible products with categories
    const products = await this.dataSource.query(`
      SELECT 
        p.product_id,
        p.product_name,
        p.short_description,
        p.product_description,
        p.product_price,
        p.retail_price,
        p.product_image,
        sc.category_name as subcategory_name,
        STRING_AGG(DISTINCT c.category_name, ', ') as category_names
      FROM product p
      LEFT JOIN product_category pc ON p.product_id = pc.product_id
      LEFT JOIN category c ON pc.category_id = c.category_id
      LEFT JOIN category sc ON p.subcategory_id = sc.category_id
      WHERE p.product_status = 1 AND p.show_in_store = true
      GROUP BY p.product_id, p.product_name, p.short_description, p.product_description,
               p.product_price, p.retail_price, p.product_image,
               sc.category_name
      ORDER BY p.product_name
    `);

    // Fetch options for all products (using actual DB schema)
    const options = await this.dataSource.query(`
      SELECT 
        po.product_id,
        o.option_id,
        o.name as option_name,
        o.option_type,
        ov.option_value_id,
        ov.name as value_name,
        ov.standard_price
      FROM product_option po
      JOIN option_value ov ON po.option_value_id = ov.option_value_id
      JOIN options o ON ov.option_id = o.option_id
      ORDER BY po.product_id, o.option_id, ov.sort_order
    `);

    // Group options by product
    const optionsByProduct = new Map<number, any[]>();
    for (const opt of options) {
      if (!optionsByProduct.has(opt.product_id)) {
        optionsByProduct.set(opt.product_id, []);
      }
      optionsByProduct.get(opt.product_id)!.push(opt);
    }

    // Build compact catalog
    const catalogLines = products.map((p: any) => {
      const price = parseFloat(p.retail_price || p.product_price || 0).toFixed(2);
      const productOptions = optionsByProduct.get(p.product_id) || [];

      let line = `[ID:${p.product_id}] ${p.product_name}`;
      if (p.category_names) line += ` | Categories: ${p.category_names}`;
      if (p.subcategory_name) line += ` | Subcategory: ${p.subcategory_name}`;
      line += ` | Price: $${price}`;
      if (p.short_description) line += ` | ${p.short_description}`;

      if (productOptions.length > 0) {
        // Group by option name
        const grouped = new Map<string, any[]>();
        for (const opt of productOptions) {
          const key = `${opt.option_id}:${opt.option_name}`;
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key)!.push(opt);
        }

        const optionStrs: string[] = [];
        for (const [key, values] of grouped) {
          const [optionId, optionName] = key.split(':');
          const valueStrs = values.map((v: any) => {
            const priceStr = parseFloat(v.standard_price || 0) > 0
              ? ` (+$${parseFloat(v.standard_price).toFixed(2)})`
              : '';
            return `${v.value_name}[vid:${v.option_value_id}]${priceStr}`;
          });
          optionStrs.push(`${optionName}[oid:${optionId}](${values[0].option_type}): ${valueStrs.join(', ')}`);
        }
        line += ` | Options: ${optionStrs.join(' ; ')}`;
      }

      return line;
    });

    const catalog = catalogLines.join('\n');
    this.catalogCache = { data: catalog, expiry: now + this.CACHE_TTL };
    this.logger.log(`Product catalog cached: ${products.length} products, ${options.length} option values`);
    return catalog;
  }

  /**
   * Build the system prompt for the AI
   */
  private buildSystemPrompt(catalog: string): string {
    const companyName = this.configService.get<string>('COMPANY_NAME') || 'St. Dreux Coffee';

    return `You are the ${companyName} Virtual Catering Manager — a friendly, knowledgeable AI assistant that helps customers plan catering orders for events.

YOUR ROLE:
- Help customers choose the right products for their events (birthdays, weddings, corporate events, parties, meetings, etc.)
- Suggest quantities based on guest count and event type
- Stay within the customer's budget when specified
- Be warm, professional, and conversational

YOUR PRODUCT CATALOG:
${catalog}

QUANTITY GUIDELINES:
- Coffee: ~2 cups per guest for a 2-hour event, ~3 for longer events
- Tea: ~1 cup per guest (offer as complement to coffee)
- Pastries/Food: ~1.5 items per guest
- For weddings/formal events: lean toward premium/specialty items
- For casual/corporate: suggest value-conscious options
- Always respect minimum quantities if specified

CONVERSATION FLOW:
1. Greet the customer and ask about their event if they haven't mentioned it
2. Gather: event type, guest count, budget (if any), dietary preferences
3. Once you have enough info, make specific product recommendations
4. Explain why each product fits their event
5. Offer to adjust based on feedback

RESPONSE FORMAT — You MUST respond with valid JSON only, no markdown, no extra text:
{
  "reply": "Your friendly conversational message to the customer",
  "suggestions": [
    {
      "product_id": <number from catalog ID>,
      "product_name": "<exact name from catalog>",
      "quantity": <number>,
      "reason": "<brief reason why this product fits>",
      "options": [
        {
          "option_id": <oid number from catalog>,
          "option_value_id": <vid number from catalog>,
          "option_name": "<option name>",
          "option_value": "<value name>"
        }
      ]
    }
  ],
  "canAddToCart": <true if suggestions are complete, false if still gathering info>,
  "followUpQuestions": ["<optional follow-up question>"]
}

RULES:
- "suggestions" must be null if you're still gathering information
- "canAddToCart" must be false if suggestions is null
- Only recommend products that exist in the catalog above — use exact product_id values
- Include options only when relevant and available in the catalog
- Never invent product IDs or option IDs — only use IDs from the catalog
- If a customer asks for something not in the catalog, politely let them know and suggest alternatives
- Keep "reply" conversational and friendly, not robotic
- Keep "reason" brief (one sentence)`;
  }

  /**
   * Main chat method — sends message to Gemini and returns structured response
   */
  async chat(
    message: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    authHeader?: string,
  ): Promise<ChatResponse> {
    if (!this.groq) {
      throw new BadRequestException('AI chatbot is not configured. Please contact support.');
    }

    // Basic input validation
    if (!message || message.trim().length === 0) {
      throw new BadRequestException('Message cannot be empty');
    }

    if (message.length > 2000) {
      throw new BadRequestException('Message is too long. Please keep it under 2000 characters.');
    }

    // Limit conversation history to last 10 messages to control tokens
    const trimmedHistory = conversationHistory.slice(-10);

    try {
      const catalog = await this.buildProductCatalog();
      const systemPrompt = this.buildSystemPrompt(catalog);

      // Build messages array for Groq (OpenAI-compatible format)
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt },
        ...trimmedHistory.map((msg) => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        })),
        { role: 'user', content: message },
      ];

      const completion = await this.groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.7,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      });

      const responseText = completion.choices[0]?.message?.content || '';

      let parsed: ChatResponse;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        this.logger.warn('Failed to parse AI response as JSON, wrapping as reply');
        parsed = {
          reply: responseText,
          suggestions: null,
          canAddToCart: false,
        };
      }

      // Validate and enrich suggestions with real DB data
      if (parsed.suggestions && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
        parsed.suggestions = await this.validateAndEnrichSuggestions(parsed.suggestions);
        parsed.canAddToCart = parsed.suggestions.length > 0;
      } else {
        parsed.suggestions = null;
        parsed.canAddToCart = false;
      }

      return parsed;
    } catch (error: any) {
      this.logger.error('Chatbot error:', error);

      const errMsg = error?.message || error?.toString() || '';
      if (errMsg.includes('quota') || errMsg.includes('rate') || errMsg.includes('429') || errMsg.includes('Too Many Requests')) {
        throw new BadRequestException('The AI assistant is temporarily busy due to rate limits. Please wait a minute and try again.');
      }

      if (errMsg.includes('API_KEY') || errMsg.includes('api key') || errMsg.includes('401') || errMsg.includes('403')) {
        throw new BadRequestException('The AI assistant is not properly configured. Please contact support.');
      }

      throw new BadRequestException(`Failed to get a response from the AI assistant. Please try again. (${errMsg.substring(0, 100)})`);
    }
  }

  /**
   * Validate suggested product IDs exist and enrich with current pricing
   */
  private async validateAndEnrichSuggestions(
    suggestions: any[],
  ): Promise<ProductSuggestion[]> {
    const productIds = suggestions
      .map((s) => s.product_id)
      .filter((id) => typeof id === 'number' && id > 0);

    if (productIds.length === 0) return [];

    const products = await this.dataSource.query(
      `SELECT product_id, product_name, product_price, retail_price,
              product_image, product_status, show_in_store
       FROM product
       WHERE product_id = ANY($1)`,
      [productIds],
    );

    const productMap = new Map<number, any>(products.map((p: any) => [p.product_id, p]));

    // Fetch option values for validation
    const allOptionValueIds = suggestions
      .flatMap((s) => (s.options || []).map((o: any) => o.option_value_id))
      .filter((id: number) => typeof id === 'number' && id > 0);

    let optionValueMap = new Map<number, any>();
    if (allOptionValueIds.length > 0) {
      const optionValues = await this.dataSource.query(
        `SELECT ov.option_value_id, ov.option_id, ov.name as value_name,
                ov.standard_price, o.name as option_name
         FROM option_value ov
         JOIN options o ON ov.option_id = o.option_id
         WHERE ov.option_value_id = ANY($1)`,
        [allOptionValueIds],
      );
      optionValueMap = new Map(optionValues.map((ov: any) => [ov.option_value_id, ov]));
    }

    return suggestions
      .filter((s) => {
        const p = productMap.get(s.product_id);
        return p && p.product_status === 1 && p.show_in_store;
      })
      .map((s) => {
        const p = productMap.get(s.product_id)!;
        const price = parseFloat(p.retail_price || p.product_price || 0);
        const quantity = Math.max(1, Math.round(s.quantity || 1));

        // Validate and enrich options
        const validOptions = (s.options || [])
          .filter((opt: any) => optionValueMap.has(opt.option_value_id))
          .map((opt: any) => {
            const dbOpt = optionValueMap.get(opt.option_value_id);
            return {
              option_id: dbOpt.option_id,
              option_value_id: opt.option_value_id,
              option_name: dbOpt.option_name,
              option_value: dbOpt.value_name,
              option_price: parseFloat(dbOpt.standard_price || 0).toFixed(4),
              option_price_prefix: '+',
            };
          });

        // Calculate total including options
        let unitPrice = price;
        for (const opt of validOptions) {
          unitPrice += parseFloat(opt.option_price);
        }

        return {
          product_id: p.product_id,
          product_name: p.product_name,
          quantity,
          reason: s.reason || '',
          product_price: price,
          product_image: p.product_image || null,
          estimated_total: parseFloat((unitPrice * quantity).toFixed(2)),
          options: validOptions.length > 0 ? validOptions : undefined,
        };
      });
  }

  /**
   * Email chatbot suggestions as a quote to the customer
   */
  async emailQuote(data: EmailQuoteRequest, authHeader?: string): Promise<{ success: boolean; message: string }> {
    const { suggestions, customerEmail, customerName, eventDetails } = data;

    if (!customerEmail || !customerEmail.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      throw new BadRequestException('A valid email address is required');
    }

    if (!suggestions || suggestions.length === 0) {
      throw new BadRequestException('No products to include in the quote');
    }

    const companyName = this.configService.get<string>('COMPANY_NAME') || 'St. Dreux Coffee';
    const companyPhone = this.configService.get<string>('COMPANY_PHONE') || '';
    const companyEmail = this.configService.get<string>('COMPANY_EMAIL') || '';
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';

    // Calculate totals
    let grandTotal = 0;
    const productRows = suggestions.map((item) => {
      const itemTotal = item.estimated_total || item.product_price * item.quantity;
      grandTotal += itemTotal;

      const optionsHtml = item.options && item.options.length > 0
        ? `<div style="font-size: 12px; color: #666; margin-top: 4px;">${item.options.map((o) => `${o.option_name}: ${o.option_value}`).join(', ')}</div>`
        : '';

      return `
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid #f0f0f5;">
            ${item.product_name}
            ${optionsHtml}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #f0f0f5; text-align: center;">${item.quantity}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f0f0f5; text-align: right;">$${item.product_price.toFixed(2)}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f0f0f5; text-align: right; font-weight: bold;">$${itemTotal.toFixed(2)}</td>
        </tr>`;
    }).join('');

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f7; }
    .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
    .header { background-color: #2952E6; color: #ffffff; padding: 30px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; font-weight: bold; }
    .header p { margin: 8px 0 0; opacity: 0.9; font-size: 14px; }
    .content { padding: 30px; }
    .table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    .table th { text-align: left; background-color: #f8f9fa; padding: 12px; font-size: 13px; border-bottom: 2px solid #eaeaef; color: #666; }
    .table th:nth-child(2), .table th:nth-child(3), .table th:nth-child(4) { text-align: center; }
    .table th:last-child { text-align: right; }
    .grand-total { text-align: right; margin-top: 20px; padding-top: 15px; border-top: 2px solid #2952E6; }
    .grand-total span { font-size: 22px; font-weight: bold; color: #2952E6; }
    .button-container { text-align: center; margin: 30px 0; }
    .button { background-color: #2952E6; color: #ffffff !important; padding: 16px 32px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 16px; }
    .footer { text-align: center; padding: 25px; color: #9a9ea6; font-size: 12px; }
    .event-details { background: #f0f4ff; border-left: 4px solid #2952E6; padding: 15px; margin: 20px 0; border-radius: 0 6px 6px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${companyName}</h1>
      <p>Your Catering Quote</p>
    </div>
    <div class="content">
      <p>Dear ${customerName || 'Valued Customer'},</p>
      <p>Thank you for using our AI Catering Manager! Here's a summary of the recommended items for your event:</p>

      ${eventDetails ? `<div class="event-details"><strong>Event Details:</strong> ${eventDetails}</div>` : ''}

      <table class="table">
        <thead>
          <tr>
            <th>Product</th>
            <th style="text-align: center;">Qty</th>
            <th style="text-align: right;">Unit Price</th>
            <th style="text-align: right;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${productRows}
        </tbody>
      </table>

      <div class="grand-total">
        Estimated Total: <span>$${grandTotal.toFixed(2)}</span>
      </div>

      <p style="margin-top: 25px; color: #666; font-size: 14px;">
        <em>Note: This is an estimated quote generated by our AI assistant. Final pricing may vary based on availability and any custom requirements. A member of our team will follow up to confirm your order.</em>
      </p>

      <div class="button-container">
        <a href="${frontendUrl}/shop" class="button">Shop Now</a>
      </div>

      <p style="color: #666; font-size: 14px;">
        Have questions? Contact us${companyPhone ? ` at ${companyPhone}` : ''}${companyEmail ? ` or email <a href="mailto:${companyEmail}">${companyEmail}</a>` : ''}.
      </p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;

    try {
      // Try using notification service template first, fallback to direct email
      const result = await this.emailService.sendEmail({
        to: customerEmail,
        subject: `${companyName} — Your Catering Quote`,
        html: emailHtml,
      });

      if (result.success) {
        // Log the email
        try {
          await this.dataSource.query(
            `INSERT INTO email_logs (template_key, recipient_email, recipient_name, subject, status, sent_at, metadata)
             VALUES ($1, $2, $3, $4, 'sent', CURRENT_TIMESTAMP, $5)`,
            [
              'chatbot_quote',
              customerEmail,
              customerName || null,
              `${companyName} — Your Catering Quote`,
              JSON.stringify({ products_count: suggestions.length, grand_total: grandTotal }),
            ],
          );
        } catch (logError) {
          this.logger.warn('Failed to log quote email:', logError);
        }

        return { success: true, message: 'Quote has been sent to your email!' };
      }

      throw new Error(result.error || 'Failed to send email');
    } catch (error: any) {
      this.logger.error('Failed to send quote email:', error);
      throw new BadRequestException('Failed to send the quote email. Please try again.');
    }
  }
}
