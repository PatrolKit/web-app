-- Who is creating an item in Square right now (Plan 47): two paths creating
-- the same item made duplicates. Additive; null for every existing row.
ALTER TABLE `SwapItem`
    ADD COLUMN `squareCreateClaim` VARCHAR(40) NULL,
    ADD COLUMN `squareCreateClaimedAt` DATETIME(3) NULL;
