-- Exchanges (Plan 49): an item handed back for another, recorded at the
-- counter. Additive: a new table, nothing else changes.
CREATE TABLE `SwapExchange` (
    `id` VARCHAR(191) NOT NULL,
    `swapId` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `lineUid` VARCHAR(64) NOT NULL,
    `paymentId` VARCHAR(64) NULL,
    `returnedItemId` VARCHAR(191) NOT NULL,
    `replacementItemId` VARCHAR(191) NOT NULL,
    `returnedPriceCents` INTEGER NULL,
    `replacementPriceCents` INTEGER NULL,
    `note` VARCHAR(500) NULL,
    `stockSynced` BOOLEAN NOT NULL DEFAULT false,
    `supersedesId` VARCHAR(191) NULL,
    `recordedBy` VARCHAR(191) NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `cancelledBy` VARCHAR(191) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(500) NULL,
    `liveKey` VARCHAR(140) NULL,

    INDEX `SwapExchange_swapId_recordedAt_idx`(`swapId`, `recordedAt`),
    INDEX `SwapExchange_returnedItemId_idx`(`returnedItemId`),
    INDEX `SwapExchange_replacementItemId_idx`(`replacementItemId`),
    UNIQUE INDEX `SwapExchange_swapId_liveKey_key`(`swapId`, `liveKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SwapExchange` ADD CONSTRAINT `SwapExchange_swapId_fkey` FOREIGN KEY (`swapId`) REFERENCES `SkiSwap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
