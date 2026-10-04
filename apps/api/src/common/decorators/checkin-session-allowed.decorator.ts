import { SetMetadata } from '@nestjs/common';

export const CHECKIN_SESSION_ALLOWED_KEY = 'checkinSessionAllowed';

/**
 * Opens a route to a check-in session (Plan 33 D6): one started at a station
 * from its QR code. Everything else refuses it. On a controller it opens every
 * route there; on a handler, just that one.
 */
export const CheckinSessionAllowed = () => SetMetadata(CHECKIN_SESSION_ALLOWED_KEY, true);
