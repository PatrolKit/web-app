import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

interface ErrorResponse {
  success: false;
  error: string;
  code?: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();

      if (typeof exResponse === 'string') {
        message = exResponse;
      } else if (typeof exResponse === 'object' && exResponse !== null) {
        const obj = exResponse as Record<string, unknown>;
        message =
          typeof obj['message'] === 'string'
            ? obj['message']
            : Array.isArray(obj['message'])
              ? (obj['message'] as string[]).join(', ')
              : message;
        code = typeof obj['code'] === 'string' ? obj['code'] : undefined;
      }
    }

    const body: ErrorResponse = { success: false, error: message };
    if (code) body.code = code;

    response.status(status).json(body);
  }
}
