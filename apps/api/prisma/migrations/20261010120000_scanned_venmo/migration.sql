-- Plan 35: only a proven payout destination is paid. A Venmo account must come
-- from the seller's Venmo code, scanned at the counter; this records when.
ALTER TABLE `User` ADD COLUMN `payoutHandleScannedAt` DATETIME(3) NULL;

-- The owner's call: Venmo accounts already on file count as scanned, so they're
-- paid as before. Anything set from now on must be scanned.
UPDATE `User` SET `payoutHandleScannedAt` = CURRENT_TIMESTAMP(3)
  WHERE `payoutMethod` = 'VENMO' AND `payoutTarget` = 'VENMO_ID' AND `payoutHandle` IS NOT NULL;
