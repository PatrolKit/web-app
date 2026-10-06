-- CreateTable
CREATE TABLE `SwapDiagnosticRun` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `swapId` VARCHAR(191) NOT NULL,
    `startedBy` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `finishedAt` DATETIME(3) NULL,
    `status` VARCHAR(16) NOT NULL,
    `done` INTEGER NOT NULL DEFAULT 0,
    `error` TEXT NULL,
    `ourCount` INTEGER NULL,
    `squareCount` INTEGER NULL,

    INDEX `SwapDiagnosticRun_swapId_startedAt_idx`(`swapId`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SwapDiagnosticIssue` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `swapId` VARCHAR(191) NOT NULL,
    `sku` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `field` VARCHAR(8) NULL,
    `ours` JSON NULL,
    `square` JSON NULL,
    `fingerprint` VARCHAR(64) NOT NULL,
    `state` VARCHAR(8) NOT NULL DEFAULT 'open',
    `choice` VARCHAR(24) NULL,
    `decidedBy` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `error` TEXT NULL,

    INDEX `SwapDiagnosticIssue_runId_kind_idx`(`runId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SwapDiagnosticHidden` (
    `id` VARCHAR(191) NOT NULL,
    `swapId` VARCHAR(191) NOT NULL,
    `sku` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `field` VARCHAR(8) NOT NULL DEFAULT '',
    `fingerprint` VARCHAR(64) NOT NULL,
    `hiddenBy` VARCHAR(191) NULL,
    `hiddenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SwapDiagnosticHidden_swapId_sku_kind_field_fingerprint_key`(`swapId`, `sku`, `kind`, `field`, `fingerprint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SwapDiagnosticRun` ADD CONSTRAINT `SwapDiagnosticRun_swapId_fkey` FOREIGN KEY (`swapId`) REFERENCES `SkiSwap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapDiagnosticIssue` ADD CONSTRAINT `SwapDiagnosticIssue_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `SwapDiagnosticRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapDiagnosticHidden` ADD CONSTRAINT `SwapDiagnosticHidden_swapId_fkey` FOREIGN KEY (`swapId`) REFERENCES `SkiSwap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

