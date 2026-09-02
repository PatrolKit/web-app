-- AlterTable
ALTER TABLE `Device` ADD COLUMN `bootstrapAt` DATETIME(3) NULL,
    ADD COLUMN `hardwareId` VARCHAR(128) NULL,
    ADD COLUMN `imageName` VARCHAR(128) NULL,
    ADD COLUMN `imageVersion` VARCHAR(64) NULL,
    ADD COLUMN `installedPackages` TEXT NULL;

-- CreateTable
CREATE TABLE `BootstrapRepository` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `uri` VARCHAR(512) NOT NULL,
    `suite` VARCHAR(64) NOT NULL,
    `components` VARCHAR(255) NOT NULL,
    `arch` VARCHAR(16) NOT NULL DEFAULT 'arm64',
    `signedByKeyId` VARCHAR(64) NOT NULL,
    `pinPriority` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BootstrapRepository_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BootstrapProfile` (
    `id` VARCHAR(191) NOT NULL,
    `role` VARCHAR(100) NOT NULL,
    `deviceType` VARCHAR(64) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `updateEnabled` BOOLEAN NOT NULL DEFAULT true,
    `updateWindow` VARCHAR(16) NULL,
    `checkinIntervalSec` INTEGER NOT NULL DEFAULT 3600,
    `manifestVersion` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BootstrapProfile_role_key`(`role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BootstrapPackage` (
    `id` VARCHAR(191) NOT NULL,
    `profileId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `version` VARCHAR(64) NULL,
    `resolvedVersion` VARCHAR(64) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `BootstrapPackage_profileId_idx`(`profileId`),
    UNIQUE INDEX `BootstrapPackage_profileId_name_key`(`profileId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `_BootstrapProfileToBootstrapRepository` (
    `A` VARCHAR(191) NOT NULL,
    `B` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `_BootstrapProfileToBootstrapRepository_AB_unique`(`A`, `B`),
    INDEX `_BootstrapProfileToBootstrapRepository_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BootstrapPackage` ADD CONSTRAINT `BootstrapPackage_profileId_fkey` FOREIGN KEY (`profileId`) REFERENCES `BootstrapProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_BootstrapProfileToBootstrapRepository` ADD CONSTRAINT `_BootstrapProfileToBootstrapRepository_A_fkey` FOREIGN KEY (`A`) REFERENCES `BootstrapProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_BootstrapProfileToBootstrapRepository` ADD CONSTRAINT `_BootstrapProfileToBootstrapRepository_B_fkey` FOREIGN KEY (`B`) REFERENCES `BootstrapRepository`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
