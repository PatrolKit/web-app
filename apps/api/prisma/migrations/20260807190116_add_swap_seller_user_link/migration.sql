/*
  Warnings:

  - A unique constraint covering the columns `[orgId,userId]` on the table `SwapSeller` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `SwapSeller` ADD COLUMN `userId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `SwapSeller_userId_idx` ON `SwapSeller`(`userId`);

-- CreateIndex
CREATE UNIQUE INDEX `SwapSeller_orgId_userId_key` ON `SwapSeller`(`orgId`, `userId`);

-- AddForeignKey
ALTER TABLE `SwapSeller` ADD CONSTRAINT `SwapSeller_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
