-- AlterTable
ALTER TABLE `SwapItem` ADD COLUMN `hasPrintedTag` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `SwapPrinter` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `bluetoothName` VARCHAR(191) NOT NULL,
    `assignedSellerId` VARCHAR(191) NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SwapPrinter_orgId_idx`(`orgId`),
    INDEX `SwapPrinter_assignedSellerId_idx`(`assignedSellerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SwapPrinter` ADD CONSTRAINT `SwapPrinter_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapPrinter` ADD CONSTRAINT `SwapPrinter_assignedSellerId_fkey` FOREIGN KEY (`assignedSellerId`) REFERENCES `SwapSeller`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
