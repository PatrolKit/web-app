-- AlterTable
ALTER TABLE `SwapPrinter` ADD COLUMN `model` VARCHAR(191) NOT NULL DEFAULT 'm110',
    MODIFY `paperSize` VARCHAR(191) NOT NULL DEFAULT '50x30',
    MODIFY `marginLeft` INTEGER NOT NULL DEFAULT 0,
    MODIFY `marginRight` INTEGER NOT NULL DEFAULT 28;

-- Existing stock. `40x30` was a size in name only: it shared every number with
-- `50x30` — same head, same canvas height — and was kept on the label only by
-- margins somebody typed. Move those printers to the one size an M110 takes,
-- and reset the inset to that size's defaults rather than carrying numbers that
-- were compensating for a geometry the code never modelled.
UPDATE `SwapPrinter`
   SET `paperSize`    = '50x30',
       `marginTop`    = 4,
       `marginBottom` = 4,
       `marginLeft`   = 0,
       `marginRight`  = 28
 WHERE `paperSize` <> '50x30';
