/*
  Warnings:

  - You are about to drop the column `locationId` on the `SquareConfig` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `SkiSwap` ADD COLUMN `locationId` VARCHAR(191) NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE `SquareConfig` DROP COLUMN `locationId`;
