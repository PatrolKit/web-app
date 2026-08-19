ALTER TABLE `Device` ADD COLUMN `skiSwapDeviceCode` VARCHAR(3) NULL;
ALTER TABLE `Device` ADD UNIQUE INDEX `Device_orgId_skiSwapDeviceCode_key` (`orgId`, `skiSwapDeviceCode`);
