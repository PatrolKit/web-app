-- A swap's time zone, for the times on its receipts. Every swap so far is in
-- the Northeast.

-- AlterTable
ALTER TABLE `SkiSwap` ADD COLUMN `timeZone` VARCHAR(191) NOT NULL DEFAULT 'America/New_York';
