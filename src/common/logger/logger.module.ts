import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: 'info',

        // 🎨 Pretty logs (dev mode)
        transport:
          process.env.NODE_ENV !== 'production'
            ? {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  translateTime: 'SYS:standard',
                  singleLine: true,

                  // 🔥 show INFO/WARN/ERROR instead of numbers
                  customLevels: 'debug:20,info:30,warn:40,error:50',
                },
              }
            : undefined,

        // 🧠 Make logs cleaner
        serializers: {
          req(req) {
            return {
              method: req.method,
              url: req.url,
            };
          },
          res(res) {
            return {
              statusCode: res.statusCode,
            };
          },
        },

        // 📌 Add global context
        base: {
          service: 'nest-api',
        },
      },
    }),
  ],
})
export class AppLoggerModule {}
