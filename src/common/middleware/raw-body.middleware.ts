import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class RawBodyMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    if (
      req.path === '/store/payment/stripe/webhook' ||
      req.path === '/webhooks/xero'
    ) {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        (req as any).rawBody = Buffer.from(data, 'utf8');
        next();
      });
    } else {
      next();
    }
  }
}

