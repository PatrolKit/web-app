import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedDevice } from '../guards/device-auth.guard';

export const CurrentDevice = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedDevice => {
    const req = ctx.switchToHttp().getRequest<{ device: AuthenticatedDevice }>();
    return req.device;
  },
);
