-- AlterTable
ALTER TABLE `Device` ADD COLUMN `resortId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Device_resortId_idx` ON `Device`(`resortId`);

-- AddForeignKey
ALTER TABLE `Device` ADD CONSTRAINT `Device_resortId_fkey` FOREIGN KEY (`resortId`) REFERENCES `Resort`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
