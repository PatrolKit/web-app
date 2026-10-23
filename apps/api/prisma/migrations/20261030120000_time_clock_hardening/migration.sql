-- Plan 55: Time Tracking catches up with Ski Swap. Additive.
--
-- A shift remembers the event that closed it (D1) and becomes a tombstone
-- rather than being deleted (D6); an event records where its terminal stood
-- (D4); the delta walk gets an index in its own order (D7). The cutover that
-- splits the year into seasons is an org setting (D12).

-- AlterTable
ALTER TABLE `TimeClockShift` ADD COLUMN `closeEventId` VARCHAR(191) NULL,
    ADD COLUMN `deletedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `TimeClockEvent` ADD COLUMN `deviceResortId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Organization` ADD COLUMN `seasonCutover` VARCHAR(5) NOT NULL DEFAULT '07-01';

-- CreateIndex
CREATE INDEX `TimeClockShift_orgId_updatedAt_id_idx` ON `TimeClockShift`(`orgId`, `updatedAt`, `id`);
