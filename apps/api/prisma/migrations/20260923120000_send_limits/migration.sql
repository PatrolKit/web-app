-- Plan 26: limits keyed by destination, and a record of how close traffic comes.

-- Codes and receipts are now counted per destination, and texts per hour.
CREATE INDEX `ContactChallenge_target_createdAt_idx` ON `ContactChallenge`(`target`, `createdAt`);
CREATE INDEX `ContactChallenge_channel_createdAt_idx` ON `ContactChallenge`(`channel`, `createdAt`);
CREATE INDEX `ReceiptDelivery_destination_createdAt_idx` ON `ReceiptDelivery`(`destination`, `createdAt`);
CREATE INDEX `ReceiptDelivery_channel_createdAt_idx` ON `ReceiptDelivery`(`channel`, `createdAt`);

-- Counts only. `''` rather than NULL for platform-wide: this is the primary key.
CREATE TABLE `LimitUsage` (
    `limitId` VARCHAR(64) NOT NULL,
    `hourStart` DATETIME(3) NOT NULL,
    `orgId` VARCHAR(64) NOT NULL DEFAULT '',
    `swapId` VARCHAR(64) NOT NULL DEFAULT '',
    `peakHits` INTEGER NOT NULL,
    `limitValue` INTEGER NOT NULL,
    `nearCount` INTEGER NOT NULL DEFAULT 0,
    `refusedCount` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LimitUsage_hourStart_idx`(`hourStart`),
    PRIMARY KEY (`limitId`, `hourStart`, `orgId`, `swapId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
