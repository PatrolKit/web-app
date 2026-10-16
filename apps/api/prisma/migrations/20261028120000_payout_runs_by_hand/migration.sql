-- Plan 52: payout runs built by hand. Reshapes the payout tables, dropping
-- what the old window-built runs needed. Approved 2026-10-14 as an exception to
-- additive-only migrations, for these tables only.
--
-- Runs only on empty payout tables: the existing runs are deleted first by
-- scripts/delete-payout-runs.mjs, which refuses if any was ever handed to
-- PayPal or had a check marked sent. This guard stops the migration otherwise.
CREATE TEMPORARY TABLE `_plan52_guard` (`runs` INTEGER NOT NULL, CONSTRAINT `payout_runs_must_be_deleted_first` CHECK (`runs` = 0));
INSERT INTO `_plan52_guard` SELECT COUNT(*) FROM `PayoutRun`;
DROP TEMPORARY TABLE `_plan52_guard`;

-- AlterTable
ALTER TABLE `PayoutLine` DROP COLUMN `checkNumber`,
    DROP COLUMN `checkSentAt`,
    ADD COLUMN `activeKey` VARCHAR(80) NULL,
    ADD COLUMN `approvedNetCents` INTEGER NULL,
    ADD COLUMN `commissionBasisPoints` INTEGER NULL,
    ADD COLUMN `frozenAt` DATETIME(3) NULL,
    ADD COLUMN `settledAt` DATETIME(3) NULL,
    ADD COLUMN `settledBy` VARCHAR(191) NULL,
    ADD COLUMN `settledNote` TEXT NULL,
    ADD COLUMN `swapId` VARCHAR(191) NOT NULL,
    ADD COLUMN `transactionId` VARCHAR(64) NULL,
    MODIFY `method` VARCHAR(8) NULL,
    MODIFY `grossCents` INTEGER NULL,
    MODIFY `commissionCents` INTEGER NULL,
    MODIFY `netCents` INTEGER NULL;

-- AlterTable
ALTER TABLE `PayoutLineItem` ADD COLUMN `lineUid` VARCHAR(64) NULL,
    ADD COLUMN `paymentId` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `PayoutRun` DROP COLUMN `commissionBasisPoints`,
    DROP COLUMN `heldSales`,
    DROP COLUMN `salesFrom`,
    DROP COLUMN `salesTo`,
    DROP COLUMN `unmatchedSales`,
    ADD COLUMN `batchReason` TEXT NULL,
    ADD COLUMN `batchStatus` VARCHAR(12) NULL,
    ADD COLUMN `kind` VARCHAR(8) NOT NULL,
    ADD COLUMN `payoutBatchId` VARCHAR(191) NULL,
    ADD COLUMN `paypalFeeCents` INTEGER NULL;

-- AlterTable
ALTER TABLE `SkiSwapSettings` ADD COLUMN `paypalFeeBps` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `paypalFeeCapCents` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `paypalFeeFlatCents` INTEGER NOT NULL DEFAULT 25;

-- CreateIndex
CREATE UNIQUE INDEX `PayoutLine_activeKey_key` ON `PayoutLine`(`activeKey`);

-- CreateIndex
CREATE INDEX `PayoutLine_swapId_sellerId_idx` ON `PayoutLine`(`swapId`, `sellerId`);

