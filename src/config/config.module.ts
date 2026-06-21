import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { initializeSecrets } from './secrets.config';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      load: [async () => {
        // Load secrets from AWS Secrets Manager if configured
        if (
          process.env.SECRET_NAME || 
          process.env.AWS_SECRET_NAME || 
          process.env.NODE_ENV === 'production'
        ) {
          try {
            await initializeSecrets();
          } catch (error) {
            console.error('❌ Error loading secrets:', error);
            console.warn('⚠️  Falling back to environment variables');
          }
        }
        return {};
      }],
    }),
  ],
})
export class ConfigModule {}

