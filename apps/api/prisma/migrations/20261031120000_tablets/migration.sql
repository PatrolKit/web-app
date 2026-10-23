-- Plan 56: Tablets. Additive.
--
-- A tablet reports what it is doing (D4); one PIN guards every tablet in the
-- org (D5), seeded from the Ski Swap PIN, else the Time Tracking one; a
-- station's kind is stored (D6), backfilled from whether it has a tablet.

-- AlterTable
ALTER TABLE `Device` ADD COLUMN `appMode` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `Organization` ADD COLUMN `tabletPin` VARCHAR(4) NULL;

-- AlterTable
ALTER TABLE `CheckinStation` ADD COLUMN `staffed` BOOLEAN NOT NULL DEFAULT false;

-- Backfill
UPDATE `Organization` o
  LEFT JOIN `SkiSwapSettings` s ON s.`orgId` = o.`id`
  LEFT JOIN `TimeClockSettings` t ON t.`orgId` = o.`id`
  SET o.`tabletPin` = COALESCE(s.`devicePin`, t.`devicePin`);

UPDATE `CheckinStation` SET `staffed` = true WHERE `attendantDeviceId` IS NOT NULL;
