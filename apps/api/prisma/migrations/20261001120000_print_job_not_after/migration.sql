-- Plan 28: helper labels expire if no bridge takes them within a minute.

ALTER TABLE `PrintJob` ADD COLUMN `notAfter` DATETIME(3) NULL;
