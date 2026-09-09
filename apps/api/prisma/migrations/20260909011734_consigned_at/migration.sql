-- AlterTable
ALTER TABLE `SkiSwapSettings` ADD COLUMN `requireConsignmentScan` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `SwapItem` ADD COLUMN `consignedAt` DATETIME(3) NULL,
    ADD COLUMN `consignedBy` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `SwapItem_swapId_consignedAt_idx` ON `SwapItem`(`swapId`, `consignedAt`);

-- Every item that already exists is on the floor, so it is consigned. Leaving
-- them null would make live inventory vanish from Square's point of view the
-- moment anything reconciled against `consignedAt` — a worse bug than the one
-- this column fixes.
UPDATE `SwapItem` SET `consignedAt` = `createdAt` WHERE `consignedAt` IS NULL;
