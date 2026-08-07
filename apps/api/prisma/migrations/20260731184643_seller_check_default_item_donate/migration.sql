-- AlterTable
ALTER TABLE `SwapItem` ADD COLUMN `donateProceeds` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `SwapSeller` MODIFY `payoutMethod` VARCHAR(191) NULL DEFAULT 'CHECK';
