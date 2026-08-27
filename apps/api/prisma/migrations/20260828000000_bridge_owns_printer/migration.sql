-- DropForeignKey
ALTER TABLE `CheckinStation` DROP FOREIGN KEY `CheckinStation_printerId_fkey`;

-- DropIndex
DROP INDEX `CheckinStation_printerId_key` ON `CheckinStation`;

-- AlterTable
ALTER TABLE `CheckinStation` DROP COLUMN `printerId`;

-- AlterTable
ALTER TABLE `SwapPrinter` ADD COLUMN `bridgeDeviceId` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `SwapPrinter_bridgeDeviceId_key` ON `SwapPrinter`(`bridgeDeviceId`);

-- AddForeignKey
ALTER TABLE `SwapPrinter` ADD CONSTRAINT `SwapPrinter_bridgeDeviceId_fkey` FOREIGN KEY (`bridgeDeviceId`) REFERENCES `Device`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

