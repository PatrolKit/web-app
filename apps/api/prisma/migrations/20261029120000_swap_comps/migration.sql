-- Plan 53: comps, an item marked sold with no Square sale behind it. Additive.
-- CreateTable
CREATE TABLE `SwapComp` (
    `id` VARCHAR(191) NOT NULL,
    `swapId` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `units` INTEGER NOT NULL DEFAULT 1,
    `priceCents` INTEGER NOT NULL,
    `reason` VARCHAR(12) NOT NULL,
    `note` TEXT NOT NULL,
    `compedBy` VARCHAR(191) NULL,
    `compedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `undoneBy` VARCHAR(191) NULL,
    `undoneAt` DATETIME(3) NULL,
    `undoNote` TEXT NULL,
    `liveKey` VARCHAR(40) NULL,

    INDEX `SwapComp_swapId_compedAt_idx`(`swapId`, `compedAt`),
    INDEX `SwapComp_itemId_idx`(`itemId`),
    UNIQUE INDEX `SwapComp_swapId_liveKey_key`(`swapId`, `liveKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SwapComp` ADD CONSTRAINT `SwapComp_swapId_fkey` FOREIGN KEY (`swapId`) REFERENCES `SkiSwap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

