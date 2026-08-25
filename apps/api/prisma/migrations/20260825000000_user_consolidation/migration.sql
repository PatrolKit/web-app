-- DropForeignKey
ALTER TABLE `MagicLink` DROP FOREIGN KEY `MagicLink_userId_fkey`;

-- DropForeignKey
ALTER TABLE `Patroller` DROP FOREIGN KEY `Patroller_orgId_fkey`;

-- DropForeignKey
ALTER TABLE `SellerVerification` DROP FOREIGN KEY `SellerVerification_sellerId_fkey`;

-- DropForeignKey
ALTER TABLE `SwapItem` DROP FOREIGN KEY `SwapItem_sellerId_fkey`;

-- DropForeignKey
ALTER TABLE `SwapPrinter` DROP FOREIGN KEY `SwapPrinter_assignedSellerId_fkey`;

-- DropForeignKey
ALTER TABLE `SwapSeller` DROP FOREIGN KEY `SwapSeller_orgId_fkey`;

-- DropForeignKey
ALTER TABLE `SwapSeller` DROP FOREIGN KEY `SwapSeller_userId_fkey`;

-- DropForeignKey
ALTER TABLE `TimeClockEvent` DROP FOREIGN KEY `TimeClockEvent_patrollerId_fkey`;

-- DropForeignKey
ALTER TABLE `TimeClockShift` DROP FOREIGN KEY `TimeClockShift_patrollerId_fkey`;

-- DropIndex
DROP INDEX `User_email_key` ON `User`;

-- AlterTable
ALTER TABLE `Membership` DROP COLUMN `status`,
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `User` DROP COLUMN `name`,
    DROP COLUMN `status`,
    ADD COLUMN `city` VARCHAR(191) NULL,
    ADD COLUMN `emailVerifiedAt` DATETIME(3) NULL,
    ADD COLUMN `firstName` VARCHAR(191) NULL,
    ADD COLUMN `lastName` VARCHAR(191) NULL,
    ADD COLUMN `nspId` VARCHAR(191) NULL,
    ADD COLUMN `patrolLevel` VARCHAR(191) NULL,
    ADD COLUMN `payoutChannel` VARCHAR(191) NULL,
    ADD COLUMN `payoutMethod` VARCHAR(191) NULL DEFAULT 'CHECK',
    ADD COLUMN `phone` VARCHAR(191) NULL,
    ADD COLUMN `phoneVerifiedAt` DATETIME(3) NULL,
    ADD COLUMN `state` VARCHAR(191) NULL,
    ADD COLUMN `street` VARCHAR(191) NULL,
    ADD COLUMN `verifiedEmail` VARCHAR(191) NULL,
    ADD COLUMN `verifiedPhone` VARCHAR(191) NULL,
    ADD COLUMN `zip` VARCHAR(191) NULL,
    MODIFY `email` VARCHAR(191) NULL;

-- DropTable
DROP TABLE `MagicLink`;

-- DropTable
DROP TABLE `Patroller`;

-- DropTable
DROP TABLE `SellerVerification`;

-- DropTable
DROP TABLE `SwapSeller`;

-- CreateTable
CREATE TABLE `ContactChallenge` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(191) NOT NULL,
    `target` VARCHAR(191) NOT NULL,
    `purpose` VARCHAR(191) NOT NULL,
    `codeHash` VARCHAR(191) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ContactChallenge_userId_channel_usedAt_idx`(`userId`, `channel`, `usedAt`),
    INDEX `ContactChallenge_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SellerProfile` (
    `id` VARCHAR(191) NOT NULL,
    `membershipId` VARCHAR(191) NOT NULL,
    `businessName` VARCHAR(191) NULL,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SellerProfile_membershipId_key`(`membershipId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PatrollerProfile` (
    `id` VARCHAR(191) NOT NULL,
    `membershipId` VARCHAR(191) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PatrollerProfile_membershipId_key`(`membershipId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Membership_orgId_updatedAt_idx` ON `Membership`(`orgId`, `updatedAt`);

-- CreateIndex
CREATE INDEX `Membership_orgId_deletedAt_idx` ON `Membership`(`orgId`, `deletedAt`);

-- CreateIndex
CREATE UNIQUE INDEX `User_nspId_key` ON `User`(`nspId`);

-- CreateIndex
CREATE UNIQUE INDEX `User_verifiedEmail_key` ON `User`(`verifiedEmail`);

-- CreateIndex
CREATE UNIQUE INDEX `User_verifiedPhone_key` ON `User`(`verifiedPhone`);

-- CreateIndex
CREATE INDEX `User_email_idx` ON `User`(`email`);

-- CreateIndex
CREATE INDEX `User_phone_idx` ON `User`(`phone`);

-- AddForeignKey
ALTER TABLE `ContactChallenge` ADD CONSTRAINT `ContactChallenge_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SellerProfile` ADD CONSTRAINT `SellerProfile_membershipId_fkey` FOREIGN KEY (`membershipId`) REFERENCES `Membership`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapItem` ADD CONSTRAINT `SwapItem_sellerId_fkey` FOREIGN KEY (`sellerId`) REFERENCES `SellerProfile`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapPrinter` ADD CONSTRAINT `SwapPrinter_assignedSellerId_fkey` FOREIGN KEY (`assignedSellerId`) REFERENCES `SellerProfile`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PatrollerProfile` ADD CONSTRAINT `PatrollerProfile_membershipId_fkey` FOREIGN KEY (`membershipId`) REFERENCES `Membership`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimeClockEvent` ADD CONSTRAINT `TimeClockEvent_patrollerId_fkey` FOREIGN KEY (`patrollerId`) REFERENCES `PatrollerProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimeClockShift` ADD CONSTRAINT `TimeClockShift_patrollerId_fkey` FOREIGN KEY (`patrollerId`) REFERENCES `PatrollerProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

