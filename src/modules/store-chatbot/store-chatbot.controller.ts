import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { StoreChatbotService } from './store-chatbot.service';

interface ChatMessageDto {
  message: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface EmailQuoteDto {
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

@ApiTags('Store Chatbot')
@Controller('store/chatbot')
export class StoreChatbotController {
  constructor(private readonly storeChatbotService: StoreChatbotService) {}

  @Post('message')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send message to AI catering assistant' })
  async sendMessage(
    @Body() body: ChatMessageDto,
    @Headers('authorization') authHeader?: string,
  ) {
    return this.storeChatbotService.chat(
      body.message,
      body.conversationHistory || [],
      authHeader,
    );
  }

  @Post('email-quote')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email chatbot suggestions as a quote to customer' })
  async emailQuote(
    @Body() body: EmailQuoteDto,
    @Headers('authorization') authHeader?: string,
  ) {
    return this.storeChatbotService.emailQuote(body, authHeader);
  }
}
