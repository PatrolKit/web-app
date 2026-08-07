/*
  Warnings:

  - You are about to drop the `SwapItemSeller` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `SwapItemSeller` DROP FOREIGN KEY `SwapItemSeller_sellerId_fkey`;

-- DropForeignKey
ALTER TABLE `SwapItemSeller` DROP FOREIGN KEY `SwapItemSeller_swapId_fkey`;

-- DropTable
DROP TABLE `SwapItemSeller`;

-- CreateTable
CREATE TABLE `SwapItem` (
    `id` VARCHAR(191) NOT NULL,
    `swapId` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `sellerId` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `priceCents` INTEGER NOT NULL,
    `sku` VARCHAR(191) NOT NULL,
    `originalQuantity` INTEGER NOT NULL,
    `squareItemId` VARCHAR(191) NULL,
    `squareVariationId` VARCHAR(191) NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SwapItem_orgId_idx`(`orgId`),
    INDEX `SwapItem_sellerId_idx`(`sellerId`),
    UNIQUE INDEX `SwapItem_swapId_sku_key`(`swapId`, `sku`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SwapItemPhoto` (
    `id` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `s3Key` VARCHAR(191) NOT NULL DEFAULT '',
    `url` VARCHAR(191) NOT NULL,
    `squareImageId` VARCHAR(191) NULL,
    `displayOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SwapItemPhoto_itemId_idx`(`itemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SwapItem` ADD CONSTRAINT `SwapItem_swapId_fkey` FOREIGN KEY (`swapId`) REFERENCES `SkiSwap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapItem` ADD CONSTRAINT `SwapItem_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapItem` ADD CONSTRAINT `SwapItem_sellerId_fkey` FOREIGN KEY (`sellerId`) REFERENCES `SwapSeller`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapItemPhoto` ADD CONSTRAINT `SwapItemPhoto_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `SwapItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
