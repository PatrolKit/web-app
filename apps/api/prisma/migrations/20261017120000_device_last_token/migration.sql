-- When a device last traded its client secret for a token: a new pairing
-- code counts as used once this passes the time the code was issued.
ALTER TABLE `Device` ADD COLUMN `lastTokenAt` DATETIME(3) NULL;
