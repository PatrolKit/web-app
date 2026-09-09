-- AlterTable
ALTER TABLE `SkiSwap` ADD COLUMN `legacyTicketsEnabled` BOOLEAN NOT NULL DEFAULT false;

-- A swap that has already issued ticket blocks plainly accepts legacy tickets.
-- Defaulting those to false would take the ranges staff can see, the numbers a
-- shop is holding paper for, and the import button off the screen the moment
-- this deploys — a feature vanishing is a worse first impression than one that
-- was never switched on.
UPDATE `SkiSwap` s
SET s.`legacyTicketsEnabled` = true
WHERE EXISTS (SELECT 1 FROM `LegacyTicketRange` r WHERE r.`swapId` = s.`id`);
