-- AlterTable
ALTER TABLE `Device` ADD COLUMN `printerLink` VARCHAR(16) NULL,
    ADD COLUMN `printerLinkAt` DATETIME(3) NULL;
