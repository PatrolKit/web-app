-- "Labels per item" moves from the org to each swap, and a swap that takes only
-- legacy tickets can ask the iPad for helper labels.

ALTER TABLE `SkiSwap` ADD COLUMN `labelsPerItem` INTEGER NOT NULL DEFAULT 1;
ALTER TABLE `SkiSwap` ADD COLUMN `printLegacyHelperLabels` BOOLEAN NOT NULL DEFAULT false;

-- Every swap takes its org's setting, so nothing prints a different number of
-- tags the day after this ships. Swaps in an org that never saved one keep
-- the default of 1, which is what that org was getting.
UPDATE `SkiSwap` s
  JOIN `SkiSwapSettings` ss ON ss.`orgId` = s.`orgId`
   SET s.`labelsPerItem` = ss.`labelsPerItem`;

ALTER TABLE `SkiSwapSettings` DROP COLUMN `labelsPerItem`;
