-- Device telemetry (webprinter_esp32 Plan 4): reports as sent, and outages
-- measured from check-ins. Additive only.

-- AlterTable
ALTER TABLE `Device` ADD COLUMN `telemetryIntervalS` INTEGER NULL;

-- CreateTable
CREATE TABLE `DeviceTelemetry` (
    `id` VARCHAR(191) NOT NULL,
    `deviceId` VARCHAR(191) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `body` JSON NOT NULL,
    `malformedFields` JSON NULL,
    `v` INTEGER NULL,
    `firmwareVersion` VARCHAR(64) NULL,
    `board` VARCHAR(64) NULL,
    `bootCount` INTEGER NULL,
    `resetReason` VARCHAR(32) NULL,
    `uptimeMs` BIGINT NULL,
    `bootAt` DATETIME(3) NULL,
    `bootsSincePrevious` INTEGER NOT NULL DEFAULT 0,
    `unplannedReboot` BOOLEAN NOT NULL DEFAULT false,
    `memFree` INTEGER NULL,
    `memLargestBlock` INTEGER NULL,
    `memMinFreeEver` INTEGER NULL,
    `psram` BOOLEAN NULL,
    `wifiRssi` INTEGER NULL,
    `printerLink` VARCHAR(16) NULL,

    INDEX `DeviceTelemetry_deviceId_receivedAt_idx`(`deviceId`, `receivedAt`),
    INDEX `DeviceTelemetry_receivedAt_idx`(`receivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DeviceOutage` (
    `id` VARCHAR(191) NOT NULL,
    `deviceId` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NOT NULL,

    INDEX `DeviceOutage_deviceId_startedAt_idx`(`deviceId`, `startedAt`),
    INDEX `DeviceOutage_endedAt_idx`(`endedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DeviceTelemetry` ADD CONSTRAINT `DeviceTelemetry_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeviceOutage` ADD CONSTRAINT `DeviceOutage_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

