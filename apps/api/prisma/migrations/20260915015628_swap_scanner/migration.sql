-- CreateTable
CREATE TABLE `SwapScanner` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `bluetoothName` VARCHAR(191) NOT NULL,
    `bridgeDeviceId` VARCHAR(191) NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SwapScanner_bridgeDeviceId_key`(`bridgeDeviceId`),
    INDEX `SwapScanner_orgId_idx`(`orgId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SwapScanner` ADD CONSTRAINT `SwapScanner_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapScanner` ADD CONSTRAINT `SwapScanner_bridgeDeviceId_fkey` FOREIGN KEY (`bridgeDeviceId`) REFERENCES `Device`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
