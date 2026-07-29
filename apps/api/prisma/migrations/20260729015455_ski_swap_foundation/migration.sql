-- CreateTable
CREATE TABLE `SquareConfig` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `accessTokenEnc` TEXT NOT NULL,
    `environment` VARCHAR(191) NOT NULL DEFAULT 'production',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SquareConfig_orgId_key`(`orgId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SkiSwap` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `squareCategoryId` VARCHAR(191) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT false,
    `skuPrefix` VARCHAR(191) NOT NULL,
    `skuCounter` INTEGER NOT NULL DEFAULT 0,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SkiSwap_orgId_active_idx`(`orgId`, `active`),
    UNIQUE INDEX `SkiSwap_orgId_title_key`(`orgId`, `title`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SwapSeller` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `street` VARCHAR(191) NULL,
    `city` VARCHAR(191) NULL,
    `state` VARCHAR(191) NULL,
    `zip` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SwapSeller_orgId_phone_idx`(`orgId`, `phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SwapItemSeller` (
    `id` VARCHAR(191) NOT NULL,
    `swapId` VARCHAR(191) NOT NULL,
    `sellerId` VARCHAR(191) NOT NULL,
    `squareItemId` VARCHAR(191) NOT NULL,
    `squareVariationId` VARCHAR(191) NOT NULL,
    `originalQuantity` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SwapItemSeller_sellerId_idx`(`sellerId`),
    UNIQUE INDEX `SwapItemSeller_swapId_squareItemId_key`(`swapId`, `squareItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SquareConfig` ADD CONSTRAINT `SquareConfig_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SkiSwap` ADD CONSTRAINT `SkiSwap_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapSeller` ADD CONSTRAINT `SwapSeller_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapItemSeller` ADD CONSTRAINT `SwapItemSeller_swapId_fkey` FOREIGN KEY (`swapId`) REFERENCES `SkiSwap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapItemSeller` ADD CONSTRAINT `SwapItemSeller_sellerId_fkey` FOREIGN KEY (`sellerId`) REFERENCES `SwapSeller`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
