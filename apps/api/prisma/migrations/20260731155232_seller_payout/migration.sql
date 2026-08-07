-- AlterTable
ALTER TABLE `SwapSeller` ADD COLUMN `payoutIdentifier` VARCHAR(191) NULL,
    ADD COLUMN `payoutIdentifierConfirmedAt` DATETIME(3) NULL,
    ADD COLUMN `payoutIdentifierType` VARCHAR(191) NULL,
    ADD COLUMN `payoutMethod` VARCHAR(191) NULL;
