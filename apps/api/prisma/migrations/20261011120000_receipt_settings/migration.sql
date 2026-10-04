-- Plan 36: per-swap receipt settings. Every swap starts Itemized with all
-- columns, printing on 62 x 100 stock, and no fine print.

-- AlterTable
ALTER TABLE `SkiSwap` ADD COLUMN `receiptFinePrint` TEXT NULL,
    ADD COLUMN `receiptFinePrintEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `receiptLink` VARCHAR(191) NOT NULL DEFAULT 'NONE',
    ADD COLUMN `receiptMode` VARCHAR(191) NOT NULL DEFAULT 'ITEMIZED',
    ADD COLUMN `receiptPaperSize` VARCHAR(191) NOT NULL DEFAULT '62x100',
    ADD COLUMN `receiptPrintEnabled` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `receiptShowName` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `receiptShowPrice` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `receiptShowSku` BOOLEAN NOT NULL DEFAULT true;


-- Receipts link to the seller's /s/ page today: keep that where the page is on.
UPDATE `SkiSwap` SET `receiptLink` = 'SELLER_STATUS' WHERE `sellerLookupEnabled` = true;
