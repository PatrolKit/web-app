-- The composite unique on (orgId, skiSwapDeviceCode) doubled as the index MySQL
-- requires behind the orgId foreign key, so orgId needs its own index *before*
-- that one can go. Generated order had it the other way round and failed.
-- CreateIndex
CREATE INDEX `Device_orgId_idx` ON `Device`(`orgId`);

-- DropIndex
DROP INDEX `Device_orgId_skiSwapDeviceCode_key` ON `Device`;

-- DropForeignKey
ALTER TABLE `CheckinStation` DROP FOREIGN KEY `CheckinStation_deviceId_fkey`;

-- DropForeignKey
ALTER TABLE `SwapPrinter` DROP FOREIGN KEY `SwapPrinter_bridgeDeviceId_fkey`;

-- DropIndex
DROP INDEX `CheckinStation_deviceId_key` ON `CheckinStation`;

-- DropIndex
DROP INDEX `SwapPrinter_bridgeDeviceId_key` ON `SwapPrinter`;

-- AlterTable
ALTER TABLE `CheckinStation` DROP COLUMN `deviceId`,
    ADD COLUMN `attendantDeviceId` VARCHAR(191) NULL,
    ADD COLUMN `bridgeDeviceId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Device` DROP COLUMN `skiSwapDeviceCode`;

-- AlterTable
ALTER TABLE `SwapPrinter` DROP COLUMN `bridgeDeviceId`;

-- CreateIndex
CREATE UNIQUE INDEX `CheckinStation_attendantDeviceId_key` ON `CheckinStation`(`attendantDeviceId`);

-- CreateIndex
CREATE UNIQUE INDEX `CheckinStation_bridgeDeviceId_key` ON `CheckinStation`(`bridgeDeviceId`);

-- CreateIndex
CREATE UNIQUE INDEX `CheckinStation_printerId_key` ON `CheckinStation`(`printerId`);

-- AddForeignKey
ALTER TABLE `CheckinStation` ADD CONSTRAINT `CheckinStation_attendantDeviceId_fkey` FOREIGN KEY (`attendantDeviceId`) REFERENCES `Device`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CheckinStation` ADD CONSTRAINT `CheckinStation_bridgeDeviceId_fkey` FOREIGN KEY (`bridgeDeviceId`) REFERENCES `Device`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

