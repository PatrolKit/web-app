ALTER TABLE `SwapSeller` ADD COLUMN `emailVerifiedAt` DATETIME(3) NULL;
ALTER TABLE `SwapSeller` ADD COLUMN `phoneVerifiedAt` DATETIME(3) NULL;

CREATE TABLE `SellerVerification` (
  `id` VARCHAR(191) NOT NULL,
  `sellerId` VARCHAR(191) NOT NULL,
  `channel` VARCHAR(191) NOT NULL,
  `code` VARCHAR(191) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `usedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `SellerVerification_sellerId_channel_idx` (`sellerId`, `channel`),
  CONSTRAINT `SellerVerification_sellerId_fkey` FOREIGN KEY (`sellerId`) REFERENCES `SwapSeller` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
