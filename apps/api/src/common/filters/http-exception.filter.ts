import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorResponse {
  success: false;
  error: string;
  code?: string;
  /** See `details` below. Present only where an error offered some. */
  details?: unknown;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code: string | undefined;
    /**
     * Structured detail an error wants to hand back, where a sentence is not
     * enough for the client to act.
     *
     * Named explicitly rather than spread from the exception: Nest's own
     * exceptions carry fields of their own, and "include everything" would put
     * whatever they happen to hold into a public response.
     */
    let details: unknown;

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
        details = obj['details'];
      }
    }

    // Anything that is not an HttpException reached here unplanned, and the
    // client is told nothing but "Internal server error" — deliberately, since
    // the detail is ours. Without logging it, though, the detail is nobody's:
    // a 500 became a dead end that took a database probe to explain.
    if (!(exception instanceof HttpException)) {
      this.logger.error(
        { err: exception, method: request?.method, url: request?.url },
        'Unhandled exception',
      );
    }

    const body: ErrorResponse = { success: false, error: message };
    if (code) body.code = code;
    if (details !== undefined) body.details = details;

    response.status(status).json(body);
  }
}
