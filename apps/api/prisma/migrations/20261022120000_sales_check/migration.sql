-- Sales check (Plan 48): what staff decided about sale lines that aren't on a
-- swap's items, and the Square categories a swap never counts. Additive.
CREATE TABLE `SwapSaleDecision` (
    `id` VARCHAR(191) NOT NULL,
    `swapId` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `lineUid` VARCHAR(64) NOT NULL,
    `decision` VARCHAR(16) NOT NULL,
    `itemId` VARCHAR(191) NULL,
    `collectedCents` INTEGER NOT NULL,
    `variationId` VARCHAR(64) NULL,
    `note` VARCHAR(500) NULL,
    `markedSold` BOOLEAN NOT NULL DEFAULT false,
    `decidedBy` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `undoneAt` DATETIME(3) NULL,
    `undoneBy` VARCHAR(191) NULL,
    `liveKey` VARCHAR(140) NULL,

    UNIQUE INDEX `SwapSaleDecision_swapId_liveKey_key`(`swapId`, `liveKey`),
    INDEX `SwapSaleDecision_swapId_undoneAt_idx`(`swapId`, `undoneAt`),
    INDEX `SwapSaleDecision_itemId_idx`(`itemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SwapSaleDecision` ADD CONSTRAINT `SwapSaleDecision_swapId_fkey` FOREIGN KEY (`swapId`) REFERENCES `SkiSwap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SkiSwap` ADD COLUMN `ignoredSquareCategoryIds` JSON NULL;
