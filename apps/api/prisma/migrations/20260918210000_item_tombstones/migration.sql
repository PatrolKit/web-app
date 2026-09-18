-- Items are soft-deleted now, so a deletion can reach an iPad through the delta
-- instead of waiting for a full item pass to notice the absence.

ALTER TABLE `SwapItem` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `SwapItem` ADD COLUMN `liveSku` VARCHAR(191) NULL;

-- Every existing item is live, so every one keeps its number.
UPDATE `SwapItem` SET `liveSku` = `sku`;

-- Uniqueness moves to the mirror. MySQL has no partial unique index, and it
-- allows many NULLs in a unique one — so a tombstone with a NULL `liveSku`
-- stops holding its ticket number against a re-issue.
DROP INDEX `SwapItem_swapId_sku_key` ON `SwapItem`;
CREATE UNIQUE INDEX `SwapItem_swapId_liveSku_key` ON `SwapItem`(`swapId`, `liveSku`);

-- The dropped unique index was serving tag lookups as well as enforcing
-- uniqueness. It now covers only live items, so the lookups need their own.
CREATE INDEX `SwapItem_swapId_sku_idx` ON `SwapItem`(`swapId`, `sku`);
CREATE INDEX `SwapItem_orgId_sku_idx` ON `SwapItem`(`orgId`, `sku`);
