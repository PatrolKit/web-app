-- The app version and build a staff iPad reports, shown under its station's status.

ALTER TABLE `Device` ADD COLUMN `appVersion` VARCHAR(32) NULL,
    ADD COLUMN `appBuild` VARCHAR(32) NULL;
