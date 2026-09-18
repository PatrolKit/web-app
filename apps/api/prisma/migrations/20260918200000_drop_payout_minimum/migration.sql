-- There is no floor under a payout any more. A run used to hold anything under
-- a configured minimum, on the reasoning that the fee outweighed it; the money
-- is the seller's either way, and a payout nobody sends is a payout somebody
-- has to chase.

-- Any line parked by the old rule rejoins the queue it was taken out of.
UPDATE `PayoutLine` SET `status` = 'PENDING', `statusNote` = NULL WHERE `status` = 'BELOW_MINIMUM';

ALTER TABLE `SkiSwapSettings` DROP COLUMN `payoutMinimumCents`;
