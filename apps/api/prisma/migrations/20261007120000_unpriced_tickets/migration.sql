-- Plan 32: a legacy ticket may be checked in before it has a price. Staff fill
-- it in later; one sold first is rung up at a price the clerk types.
-- Relaxes NOT NULL only. Every existing row keeps its price.

ALTER TABLE `SwapItem` MODIFY `priceCents` INTEGER NULL;
ALTER TABLE `ReceiptLine` MODIFY `priceCents` INTEGER NULL;
