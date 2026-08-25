-- AlterTable
ALTER TABLE `SwapPrinter` MODIFY `marginLeft` INTEGER NOT NULL DEFAULT 8,
    MODIFY `marginRight` INTEGER NOT NULL DEFAULT 16;

-- CreateTable
CREATE TABLE `Resort` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `timeZone` VARCHAR(191) NOT NULL DEFAULT 'America/New_York',
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Resort_orgId_updatedAt_idx`(`orgId`, `updatedAt`),
    UNIQUE INDEX `Resort_orgId_name_key`(`orgId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Patroller` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `firstName` VARCHAR(191) NOT NULL,
    `lastName` VARCHAR(191) NOT NULL,
    `nspId` VARCHAR(191) NOT NULL,
    `patrolLevel` VARCHAR(191) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Patroller_orgId_updatedAt_idx`(`orgId`, `updatedAt`),
    UNIQUE INDEX `Patroller_orgId_nspId_key`(`orgId`, `nspId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TimeClockEvent` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `resortId` VARCHAR(191) NOT NULL,
    `patrollerId` VARCHAR(191) NOT NULL,
    `deviceId` VARCHAR(191) NULL,
    `type` VARCHAR(191) NOT NULL,
    `dutyType` VARCHAR(191) NULL,
    `dutyNote` VARCHAR(120) NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'device',
    `occurredAt` DATETIME(3) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `clockSkewMs` INTEGER NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'applied',
    `statusNote` VARCHAR(191) NULL,

    INDEX `TimeClockEvent_orgId_patrollerId_occurredAt_idx`(`orgId`, `patrollerId`, `occurredAt`),
    INDEX `TimeClockEvent_orgId_status_idx`(`orgId`, `status`),
    INDEX `TimeClockEvent_resortId_idx`(`resortId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TimeClockShift` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `resortId` VARCHAR(191) NOT NULL,
    `patrollerId` VARCHAR(191) NOT NULL,
    `dutyType` VARCHAR(191) NOT NULL,
    `dutyNote` VARCHAR(120) NULL,
    `clockInAt` DATETIME(3) NOT NULL,
    `clockOutAt` DATETIME(3) NULL,
    `status` VARCHAR(191) NOT NULL,
    `closeReason` VARCHAR(191) NULL,
    `flagged` BOOLEAN NOT NULL DEFAULT false,
    `editedByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TimeClockShift_orgId_resortId_status_idx`(`orgId`, `resortId`, `status`),
    INDEX `TimeClockShift_orgId_updatedAt_idx`(`orgId`, `updatedAt`),
    INDEX `TimeClockShift_orgId_patrollerId_status_idx`(`orgId`, `patrollerId`, `status`),
    INDEX `TimeClockShift_resortId_idx`(`resortId`),
    INDEX `TimeClockShift_patrollerId_idx`(`patrollerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TimeClockSettings` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `autoCloseLocalTime` VARCHAR(191) NOT NULL DEFAULT '03:00',
    `autoCloseAfterHours` INTEGER NOT NULL DEFAULT 4,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TimeClockSettings_orgId_key`(`orgId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Resort` ADD CONSTRAINT `Resort_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Patroller` ADD CONSTRAINT `Patroller_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimeClockEvent` ADD CONSTRAINT `TimeClockEvent_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimeClockEvent` ADD CONSTRAINT `TimeClockEvent_resortId_fkey` FOREIGN KEY (`resortId`) REFERENCES `Resort`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimeClockEvent` ADD CONSTRAINT `TimeClockEvent_patrollerId_fkey` FOREIGN KEY (`patrollerId`) REFERENCES `Patroller`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimeClockShift` ADD CONSTRAINT `TimeClockShift_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimeClockShift` ADD CONSTRAINT `TimeClockShift_resortId_fkey` FOREIGN KEY (`resortId`) REFERENCES `Resort`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimeClockShift` ADD CONSTRAINT `TimeClockShift_patrollerId_fkey` FOREIGN KEY (`patrollerId`) REFERENCES `Patroller`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimeClockSettings` ADD CONSTRAINT `TimeClockSettings_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
