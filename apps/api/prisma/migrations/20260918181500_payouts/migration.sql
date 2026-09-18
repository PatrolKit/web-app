-- AlterTable
ALTER TABLE `SkiSwapSettings` ADD COLUMN `commissionBasisPoints` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `PayPalConfig` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `clientId` TEXT NOT NULL,
    `clientSecretEnc` TEXT NOT NULL,
    `environment` VARCHAR(8) NOT NULL DEFAULT 'sandbox',
    `webhookId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PayPalConfig_orgId_key`(`orgId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PayoutRun` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `swapId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(12) NOT NULL,
    `salesFrom` DATETIME(3) NOT NULL,
    `salesTo` DATETIME(3) NOT NULL,
    `commissionBasisPoints` INTEGER NOT NULL,
    `sendAttempt` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,
    `closedBy` VARCHAR(191) NULL,

    INDEX `PayoutRun_orgId_createdAt_idx`(`orgId`, `createdAt`),
    INDEX `PayoutRun_swapId_status_idx`(`swapId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PayoutLine` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `sellerId` VARCHAR(191) NOT NULL,
    `sellerName` VARCHAR(191) NOT NULL,
    `method` VARCHAR(8) NOT NULL,
    `destination` VARCHAR(191) NULL,
    `destinationType` VARCHAR(12) NULL,
    `grossCents` INTEGER NOT NULL,
    `commissionCents` INTEGER NOT NULL,
    `netCents` INTEGER NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `statusNote` TEXT NULL,
    `payoutBatchId` VARCHAR(191) NULL,
    `payoutItemId` VARCHAR(191) NULL,
    `approvedBy` VARCHAR(191) NULL,
    `approvedAt` DATETIME(3) NULL,
    `sentAt` DATETIME(3) NULL,
    `checkNumber` VARCHAR(191) NULL,
    `checkSentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PayoutLine_runId_status_idx`(`runId`, `status`),
    INDEX `PayoutLine_payoutBatchId_idx`(`payoutBatchId`),
    UNIQUE INDEX `PayoutLine_runId_sellerId_key`(`runId`, `sellerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PayoutLineItem` (
    `id` VARCHAR(191) NOT NULL,
    `lineId` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `sku` VARCHAR(191) NOT NULL,
    `priceCents` INTEGER NOT NULL,
    `quantity` INTEGER NOT NULL,
    `collectedCents` INTEGER NOT NULL,
    `squareOrderId` VARCHAR(191) NOT NULL,
    `soldAt` DATETIME(3) NOT NULL,
    `refundedQty` INTEGER NOT NULL DEFAULT 0,

    INDEX `PayoutLineItem_lineId_idx`(`lineId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PayoutNotice` (
    `id` VARCHAR(191) NOT NULL,
    `lineId` VARCHAR(191) NOT NULL,
    `dayMark` INTEGER NOT NULL,
    `channel` VARCHAR(8) NOT NULL,
    `destination` VARCHAR(191) NOT NULL,
    `status` VARCHAR(12) NOT NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PayoutNotice_lineId_idx`(`lineId`),
    UNIQUE INDEX `PayoutNotice_lineId_dayMark_key`(`lineId`, `dayMark`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PayPalConfig` ADD CONSTRAINT `PayPalConfig_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PayoutRun` ADD CONSTRAINT `PayoutRun_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PayoutRun` ADD CONSTRAINT `PayoutRun_swapId_fkey` FOREIGN KEY (`swapId`) REFERENCES `SkiSwap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PayoutLine` ADD CONSTRAINT `PayoutLine_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `PayoutRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PayoutLine` ADD CONSTRAINT `PayoutLine_sellerId_fkey` FOREIGN KEY (`sellerId`) REFERENCES `SellerProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PayoutLineItem` ADD CONSTRAINT `PayoutLineItem_lineId_fkey` FOREIGN KEY (`lineId`) REFERENCES `PayoutLine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PayoutNotice` ADD CONSTRAINT `PayoutNotice_lineId_fkey` FOREIGN KEY (`lineId`) REFERENCES `PayoutLine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
