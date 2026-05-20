import { NestFactory } from '@nestjs/core';
import { ValidationPipe, HttpException, HttpStatus } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import * as crypto from 'crypto';
import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

// Ensure crypto is available globally for TypeORM
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = crypto as any;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true, // Enable raw body for webhook signature verification
  });

  // Enable CORS - Allow all origins for AWS deployment
  // Explicitly allow all origins to fix storefront CORS issues
  app.enableCors({
    origin: '*', // Allow all origins explicitly - fixes AWS CORS issues
    credentials: false, // Set to false when using origin: '*' (browser requirement)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'CSRF-TOKEN',
      'Accept',
      'Origin',
      'Access-Control-Request-Method',
      'Access-Control-Request-Headers',
    ],
    exposedHeaders: [
      'Content-Type',
      'Authorization',
      'Access-Control-Allow-Origin',
    ],
    preflightContinue: false,
    optionsSuccessStatus: 204,
    maxAge: 86400, // 24 hours - cache preflight requests
  });

  // Global exception filter for consistent error messages
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false, // Allow extra properties to match backend-medusa behavior
      exceptionFactory: (errors) => {
        // Format validation errors with clear messages
        const formattedErrors = errors.map((error) => {
          const constraints = error.constraints || {};
          const messages = Object.values(constraints);
          return {
            field: error.property,
            message: messages[0] || `${error.property} is invalid`,
          };
        });
        return new HttpException(
          {
            message: 'Validation failed',
            errors: formattedErrors,
          },
          HttpStatus.BAD_REQUEST,
        );
      },
    }),
  );

  // Swagger API Documentation
  const config = new DocumentBuilder()
    .setTitle('STX API')
    .setDescription('STX API Documentation')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'STX API Documentation',
  });

  // Health check endpoint
  app.getHttpAdapter().get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Redirect root to Swagger docs
  app.getHttpAdapter().get('/', (req, res) => {
    res.redirect('/api-docs');
  });

  // Serve local uploads directory as static files
  const uploadsDir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
  app.use('/uploads', express.static(uploadsDir));

  // TEMPORARY: Migration endpoint - downloads ZIP from a URL and extracts to volume
  // Remove this after migration is complete
  const expressInstance = app.getHttpAdapter().getInstance();
  expressInstance.post('/migrate-uploads', express.json(), async (req: any, res: any) => {
    const migrationKey = process.env.MIGRATION_KEY || 'stdreux-migrate-2026';
    if (req.headers['x-migration-key'] !== migrationKey) {
      return res.status(403).json({ error: 'Invalid migration key' });
    }
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'Provide a "url" in the JSON body pointing to the ZIP file' });
    }
    try {
      const zipPath = '/tmp/uploads_migration.zip';
      // Download the ZIP from the provided URL
      console.log(`[Migration] Downloading from: ${url}`);
      execSync(`wget -O "${zipPath}" "${url}"`, { stdio: 'pipe', timeout: 600000 });
      console.log('[Migration] Download complete, extracting...');
      // Extract ZIP to uploads directory
      execSync(`unzip -o "${zipPath}" -d "${uploadsDir}"`, { stdio: 'pipe', timeout: 300000 });
      // Clean up temp file
      fs.unlinkSync(zipPath);
      // List what was extracted
      const files = execSync(`find "${uploadsDir}" -type f | head -50`, { encoding: 'utf-8' });
      console.log('[Migration] Extraction complete');
      res.json({ success: true, message: 'Files extracted to uploads volume', sample_files: files.split('\n').filter(Boolean) });
    } catch (error: any) {
      console.error('[Migration] Failed:', error.message);
      res.status(500).json({ error: 'Migration failed', details: error.message });
    }
  });

  const port = process.env.PORT || 8000;
  await app.listen(port, '0.0.0.0');

  console.log('\n' + '='.repeat(60));
  console.log('🚀 STX API Server Started Successfully!');
  console.log('='.repeat(60));
  console.log(`📖 Swagger Documentation: http://localhost:${port}/api-docs`);
  console.log(`💚 Health Check:         http://localhost:${port}/health`);
  console.log(`🔐 Auth API:              http://localhost:${port}/auth`);
  console.log('='.repeat(60) + '\n');
}
bootstrap();
