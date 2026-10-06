-- Barcodes on a tall item tag: 1 (as before) or 2, head and foot.
ALTER TABLE `SkiSwapSettings` ADD COLUMN `barcodesPerTicket` INTEGER NOT NULL DEFAULT 1;
