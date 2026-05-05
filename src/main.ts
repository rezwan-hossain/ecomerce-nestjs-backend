import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  // app.useLogger(app.get(Logger));

  const config = new DocumentBuilder()
    .setTitle('Ecomerce Api')
    .setDescription('')
    .setVersion('0.0.1')
    .build();

  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, documentFactory);

  app.useGlobalPipes(new ZodValidationPipe());

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
