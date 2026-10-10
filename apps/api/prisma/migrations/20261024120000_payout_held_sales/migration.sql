-- Payout runs hold what a ticket rung up more than its units would overpay
-- (Plan 48): kept with the run, as unmatchedSales is. Additive: one nullable column.
ALTER TABLE `PayoutRun` ADD COLUMN `heldSales` JSON NULL;
