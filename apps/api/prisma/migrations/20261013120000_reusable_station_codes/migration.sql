-- A retired station's letter can be reused once no running swap has SKUs
-- under it. Uniqueness moves from every station's `code` to `liveCode`, which
-- mirrors `code` only while the station is live.

-- AlterTable
ALTER TABLE `CheckinStation` ADD COLUMN `liveCode` VARCHAR(1) NULL;

-- Every live station keeps its letter.
UPDATE `CheckinStation` SET `liveCode` = `code` WHERE `deletedAt` IS NULL;

-- CreateIndex, before the old one goes, so live letters are never unguarded.
CREATE UNIQUE INDEX `CheckinStation_orgId_liveCode_key` ON `CheckinStation`(`orgId`, `liveCode`);

-- DropIndex
DROP INDEX `CheckinStation_orgId_code_key` ON `CheckinStation`;
