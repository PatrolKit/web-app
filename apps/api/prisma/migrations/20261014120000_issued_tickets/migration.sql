-- Plan 38: issuing a block of tickets creates its items, so ranges are no
-- longer tracked. A ticket's holder is its item's seller.

-- DropForeignKey
ALTER TABLE `LegacyTicketRange` DROP FOREIGN KEY `LegacyTicketRange_orgId_fkey`;

-- DropForeignKey
ALTER TABLE `LegacyTicketRange` DROP FOREIGN KEY `LegacyTicketRange_swapId_fkey`;

-- DropForeignKey
ALTER TABLE `LegacyTicketRange` DROP FOREIGN KEY `LegacyTicketRange_sellerId_fkey`;

-- DropTable
DROP TABLE `LegacyTicketRange`;

