-- Plan 50: an item handed back to its seller at the end of a swap is
-- "picked up", not "returned", which reads as a sale's return.
--
-- Written by hand: Prisma writes a rename as DROP and ADD, which would lose
-- every pickup. RENAME COLUMN and RENAME INDEX change names only: no data is
-- copied or lost, and MySQL 8 does it instantly.
ALTER TABLE `SwapItem`
    RENAME COLUMN `returnedAt` TO `pickedUpAt`,
    RENAME COLUMN `returnedBy` TO `pickedUpBy`,
    RENAME COLUMN `returnedByName` TO `pickedUpByName`,
    RENAME COLUMN `returnedUnits` TO `pickedUpUnits`,
    RENAME INDEX `SwapItem_swapId_returnedAt_idx` TO `SwapItem_swapId_pickedUpAt_idx`;

-- Stored names, rewritten to the new ones (only the new names exist after).
UPDATE `SwapDiagnosticIssue` SET `kind` = 'picked_up' WHERE `kind` = 'returned';
UPDATE `SwapDiagnosticHidden` SET `kind` = 'picked_up' WHERE `kind` = 'returned';
UPDATE `SwapIssueNote` SET `issueKey` = REPLACE(`issueKey`, '|returned|', '|picked_up|')
    WHERE `page` = 'catalog' AND `issueKey` LIKE '%|returned|%';
UPDATE `AuditLog` SET `action` = 'ski_swap.item.picked_up' WHERE `action` = 'ski_swap.item.returned';
UPDATE `AuditLog` SET `action` = 'ski_swap.item.pickup_undone' WHERE `action` = 'ski_swap.item.return_undone';
