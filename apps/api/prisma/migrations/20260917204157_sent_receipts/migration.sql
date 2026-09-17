-- CreateTable
CREATE TABLE `Receipt` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `swapId` VARCHAR(191) NOT NULL,
    `sellerId` VARCHAR(191) NOT NULL,
    `stationId` VARCHAR(191) NULL,
    `token` VARCHAR(32) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `orgName` VARCHAR(191) NOT NULL,
    `orgLogoUrl` VARCHAR(191) NULL,
    `swapTitle` VARCHAR(191) NOT NULL,
    `sellerName` VARCHAR(191) NOT NULL,
    `payoutLabel` VARCHAR(191) NULL,
    `totalCents` INTEGER NOT NULL,
    `itemCount` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Receipt_token_key`(`token`),
    INDEX `Receipt_orgId_swapId_sellerId_createdAt_idx`(`orgId`, `swapId`, `sellerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReceiptLine` (
    `id` VARCHAR(191) NOT NULL,
    `receiptId` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `sku` VARCHAR(191) NOT NULL,
    `priceCents` INTEGER NOT NULL,
    `position` INTEGER NOT NULL,

    INDEX `ReceiptLine_receiptId_position_idx`(`receiptId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReceiptDelivery` (
    `id` VARCHAR(191) NOT NULL,
    `receiptId` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(8) NOT NULL,
    `destination` VARCHAR(191) NOT NULL,
    `status` VARCHAR(12) NOT NULL,
    `providerRef` VARCHAR(191) NULL,
    `error` TEXT NULL,
    `actorUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReceiptDelivery_receiptId_createdAt_idx`(`receiptId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Receipt` ADD CONSTRAINT `Receipt_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Receipt` ADD CONSTRAINT `Receipt_swapId_fkey` FOREIGN KEY (`swapId`) REFERENCES `SkiSwap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Receipt` ADD CONSTRAINT `Receipt_sellerId_fkey` FOREIGN KEY (`sellerId`) REFERENCES `SellerProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReceiptLine` ADD CONSTRAINT `ReceiptLine_receiptId_fkey` FOREIGN KEY (`receiptId`) REFERENCES `Receipt`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReceiptDelivery` ADD CONSTRAINT `ReceiptDelivery_receiptId_fkey` FOREIGN KEY (`receiptId`) REFERENCES `Receipt`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
