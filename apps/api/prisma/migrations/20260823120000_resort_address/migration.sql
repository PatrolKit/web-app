-- Resorts move from "a time-clock thing" to an org-level record with a postal
-- address. `timeZone` is now derived from state/ZIP rather than picked by hand.

-- AlterTable
ALTER TABLE `Resort`
    ADD COLUMN `street` VARCHAR(191) NULL,
    ADD COLUMN `city` VARCHAR(191) NULL,
    ADD COLUMN `state` VARCHAR(191) NULL,
    ADD COLUMN `zip` VARCHAR(191) NULL,
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    DROP COLUMN `active`;

-- DropIndex
-- Soft delete frees a name for reuse, so uniqueness is enforced over live rows
-- in ResortService instead of by the database.
DROP INDEX `Resort_orgId_name_key` ON `Resort`;

-- CreateIndex
CREATE INDEX `Resort_orgId_deletedAt_idx` ON `Resort`(`orgId`, `deletedAt`);
