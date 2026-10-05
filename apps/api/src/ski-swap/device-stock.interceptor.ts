import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

/**
 * Set while a device's request runs (Plan 39 D8). The iPads never read stock,
 * so a display read of Square is skipped for them. Decisions that need stock
 * (`soldAmong`) don't consult it and still read Square.
 */
export const deviceRequest = new AsyncLocalStorage<true>();

/** Whether the request being served is a device's. */
export const servingDevice = (): boolean => deviceRequest.getStore() === true;

/** What `DeviceItemResponseSchema` leaves out. */
const STOCK_FIELDS = ['inStock', 'soldCount', 'inventoryKnown'] as const;

function withoutStock(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutStock);
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.items)) return { ...obj, items: obj.items.map(withoutStock) };
  if (!('inStock' in obj)) return value;
  const out = { ...obj };
  for (const f of STOCK_FIELDS) delete out[f];
  return out;
}

/**
 * Item responses to a device carry no stock (Plan 39 D8): the handler runs
 * inside `deviceRequest`, so it skips Square, and whatever comes back loses the
 * stock fields, including an idempotent replay saved before this change.
 */
@Injectable()
export class DeviceStockInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ device?: unknown }>();
    if (!req.device) return next.handle();
    // Subscribed inside the store, so the handler and everything it awaits
    // sees it; `next.handle()` only runs the handler when subscribed.
    return new Observable((subscriber) =>
      deviceRequest.run(true, () => next.handle().pipe(map(withoutStock)).subscribe(subscriber)),
    );
  }
}
