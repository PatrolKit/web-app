import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * Which org and swap the current request is about, for the Server health page.
 *
 * Carried per request rather than passed down, because the places that count —
 * `ContactChallengeService.issue`, `ReceiptService.send`, `SmsService.send` —
 * sit several calls below the route that knows. The throttle guard fills it in
 * once routing has settled the params; anything that counts reads it.
 *
 * Never used to decide anything. A wrong answer here puts a number on the wrong
 * row of a chart, and nothing else.
 */
export interface RequestAttribution {
  orgId?: string;
  swapId?: string;
}

const storage = new AsyncLocalStorage<RequestAttribution>();

/** Express middleware: gives every request its own, empty, attribution. */
export function attributionMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  storage.run({}, () => next());
}

/** The current request's attribution, or nothing outside a request. */
export function currentAttribution(): RequestAttribution | undefined {
  return storage.getStore();
}

/** For tests and background work that wants to be attributed. */
export function withAttribution<T>(attribution: RequestAttribution, fn: () => T): T {
  return storage.run({ ...attribution }, fn);
}
