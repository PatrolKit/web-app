-- AlterTable
ALTER TABLE `Device` ADD COLUMN `scanQueueDepth` INTEGER NULL,
    ADD COLUMN `scannerBattery` INTEGER NULL,
    ADD COLUMN `scannerLink` VARCHAR(16) NULL,
    ADD COLUMN `scannerLinkAt` DATETIME(3) NULL;
