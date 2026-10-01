-- Plan 29: platform-wide settings, one row. SMS starts off.

CREATE TABLE `PlatformSettings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `smsEnabled` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `PlatformSettings` (`id`, `smsEnabled`, `updatedAt`) VALUES (1, false, CURRENT_TIMESTAMP(3));
