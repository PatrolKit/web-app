-- Reports issue notes (Plan 48): a person's findings on a Sales check or
-- Catalog check issue. Additive: a new table, nothing else changes.
CREATE TABLE `SwapIssueNote` (
    `id` VARCHAR(191) NOT NULL,
    `swapId` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `page` VARCHAR(8) NOT NULL,
    `issueKey` VARCHAR(200) NOT NULL,
    `text` TEXT NOT NULL,
    `updatedBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SwapIssueNote_swapId_page_issueKey_key`(`swapId`, `page`, `issueKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SwapIssueNote` ADD CONSTRAINT `SwapIssueNote_swapId_fkey` FOREIGN KEY (`swapId`) REFERENCES `SkiSwap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
