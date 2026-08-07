/*
  Warnings:

  - Made the column `role` on table `Device` required. This step will fail if there are existing NULL values in that column.

*/
-- Devices without a role are invalid under the new requirement; remove them first
DELETE FROM `Device` WHERE `role` IS NULL;

-- AlterTable
ALTER TABLE `Device` MODIFY `role` VARCHAR(100) NOT NULL;
