-- Unsold items handed back to their sellers (Plan 43).
ALTER TABLE `SwapItem`
    ADD COLUMN `returnedAt` DATETIME(3) NULL,
    ADD COLUMN `returnedBy` VARCHAR(191) NULL,
    ADD COLUMN `returnedByName` VARCHAR(191) NULL,
    ADD COLUMN `returnedUnits` INTEGER NULL;

CREATE INDEX `SwapItem_swapId_returnedAt_idx` ON `SwapItem`(`swapId`, `returnedAt`);
