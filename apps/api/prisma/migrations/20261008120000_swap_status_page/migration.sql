-- Plan 33: a slug per swap, its three status-page switches, and check-in-only
-- sessions. Every switch starts off.

ALTER TABLE `SkiSwap` ADD COLUMN `sellerLoginEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `sellerLookupEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `skuLookupEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `slug` VARCHAR(191) NULL;

-- Existing swaps take their prefix, lowercased: what a new swap's title would
-- derive. A prefix is [A-Z0-9] only, so a `-2` suffix can't collide with one.
UPDATE `SkiSwap` SET `slug` = LOWER(`skuPrefix`);

-- Two swaps of one org with the same prefix: the later ones get -2, -3.
UPDATE `SkiSwap` s
  JOIN (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `orgId`, `slug` ORDER BY `createdAt`, `id`) AS n
    FROM `SkiSwap`
  ) r ON r.`id` = s.`id`
  SET s.`slug` = CONCAT(s.`slug`, '-', r.n)
  WHERE r.n > 1;

ALTER TABLE `SkiSwap` MODIFY `slug` VARCHAR(191) NOT NULL;

CREATE UNIQUE INDEX `SkiSwap_orgId_slug_key` ON `SkiSwap`(`orgId`, `slug`);

ALTER TABLE `RefreshToken` ADD COLUMN `scope` VARCHAR(191) NOT NULL DEFAULT 'full';
