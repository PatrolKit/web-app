-- AlterTable
ALTER TABLE `SkiSwapSettings` ADD COLUMN `taxonomyVersion` INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE `SwapItem` ADD COLUMN `categoryId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `TaxonomyNode` (
    `id` VARCHAR(191) NOT NULL,
    `kind` ENUM('CATEGORY', 'ATTRIBUTE', 'VALUE') NOT NULL,
    `orgId` VARCHAR(191) NULL,
    `parentId` VARCHAR(191) NULL,
    `label` VARCHAR(120) NOT NULL,
    `iconKey` VARCHAR(40) NULL,
    `iconUrl` TEXT NULL,
    `iconS3Key` VARCHAR(300) NULL,
    `iconBlob` MEDIUMBLOB NULL,
    `status` ENUM('APPROVED', 'PENDING') NOT NULL DEFAULT 'APPROVED',
    `displayOrder` INTEGER NOT NULL DEFAULT 0,
    `retiredAt` DATETIME(3) NULL,
    `input` ENUM('SELECT', 'NUMBER') NULL,
    `nameSlot` INTEGER NULL,
    `unit` VARCHAR(12) NULL,
    `minValue` DOUBLE NULL,
    `maxValue` DOUBLE NULL,
    `step` DOUBLE NULL,
    `allowFreeEntry` BOOLEAN NOT NULL DEFAULT false,
    `dedupeKey` VARCHAR(400) NOT NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `approvedBy` VARCHAR(191) NULL,
    `approvedAt` DATETIME(3) NULL,
    `suggestedAt` DATETIME(3) NULL,

    UNIQUE INDEX `TaxonomyNode_dedupeKey_key`(`dedupeKey`),
    INDEX `TaxonomyNode_orgId_kind_idx`(`orgId`, `kind`),
    INDEX `TaxonomyNode_parentId_displayOrder_idx`(`parentId`, `displayOrder`),
    INDEX `TaxonomyNode_orgId_status_idx`(`orgId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SwapItemAttribute` (
    `id` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `attributeId` VARCHAR(191) NOT NULL,
    `valueId` VARCHAR(191) NULL,
    `numberValue` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SwapItemAttribute_valueId_idx`(`valueId`),
    INDEX `SwapItemAttribute_attributeId_idx`(`attributeId`),
    UNIQUE INDEX `SwapItemAttribute_itemId_attributeId_key`(`itemId`, `attributeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `SwapItem_orgId_categoryId_idx` ON `SwapItem`(`orgId`, `categoryId`);

-- AddForeignKey
ALTER TABLE `SwapItem` ADD CONSTRAINT `SwapItem_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `TaxonomyNode`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaxonomyNode` ADD CONSTRAINT `TaxonomyNode_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaxonomyNode` ADD CONSTRAINT `TaxonomyNode_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `TaxonomyNode`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapItemAttribute` ADD CONSTRAINT `SwapItemAttribute_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `SwapItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapItemAttribute` ADD CONSTRAINT `SwapItemAttribute_attributeId_fkey` FOREIGN KEY (`attributeId`) REFERENCES `TaxonomyNode`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapItemAttribute` ADD CONSTRAINT `SwapItemAttribute_valueId_fkey` FOREIGN KEY (`valueId`) REFERENCES `TaxonomyNode`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
