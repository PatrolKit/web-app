-- Plan 57: merge sellers. Additive.
--
-- A retired seller remembers the one it was merged into, so writes that still
-- name it (an iPad's offline queue, a receipt's link) reach the kept seller.

-- AlterTable
ALTER TABLE `SellerProfile` ADD COLUMN `mergedIntoId` VARCHAR(191) NULL,
    ADD COLUMN `mergedAt` DATETIME(3) NULL,
    ADD COLUMN `mergedBy` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `SellerProfile_mergedIntoId_idx` ON `SellerProfile`(`mergedIntoId`);
