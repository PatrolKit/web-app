-- Plan 59: the time clock from any source. Additive: five nullable columns.
--
-- entryId: the shift a clock-out names, and a kept duplicate's shift.
-- sweepAt: a server sweep's sweep moment, where the fold places it.
-- latitude, longitude, accuracyM: where a patroller's own event was sent from.
ALTER TABLE `TimeClockEvent` ADD COLUMN `accuracyM` DOUBLE NULL,
    ADD COLUMN `entryId` VARCHAR(191) NULL,
    ADD COLUMN `latitude` DOUBLE NULL,
    ADD COLUMN `longitude` DOUBLE NULL,
    ADD COLUMN `sweepAt` DATETIME(3) NULL;
