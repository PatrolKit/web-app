/*
  Warnings:

  - You are about to drop the column `revokedAt` on the `Device` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `Device` table. All the data in the column will be lost.

*/
-- Delete revoked devices before dropping the status column
DELETE FROM `Device` WHERE `status` = 'revoked';

-- AlterTable
ALTER TABLE `Device` DROP COLUMN `revokedAt`,
    DROP COLUMN `status`;
