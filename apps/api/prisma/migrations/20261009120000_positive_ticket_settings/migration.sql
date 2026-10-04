-- Plan 34: ticket settings said positively, per place. Each swap's settings are
-- carried across before the old columns go:
--   accept legacy tickets            -> legacy at check-in and on the web
--   legacy tickets only at check-in  -> no print tickets at check-in
--   legacy tickets only on the web   -> no print tickets on the web
-- Helper labels keep their column.

ALTER TABLE `SkiSwap` ADD COLUMN `allowLegacyCheckin` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `allowLegacyWeb` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `allowPrintCheckin` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `allowPrintWeb` BOOLEAN NOT NULL DEFAULT true;

UPDATE `SkiSwap` SET
    `allowLegacyCheckin` = `legacyTicketsEnabled`,
    `allowLegacyWeb` = `legacyTicketsEnabled`,
    `allowPrintCheckin` = NOT `legacyTicketsOnly`,
    `allowPrintWeb` = NOT `webLegacyTicketsOnly`;

ALTER TABLE `SkiSwap` DROP COLUMN `legacyTicketsEnabled`,
    DROP COLUMN `legacyTicketsOnly`,
    DROP COLUMN `webLegacyTicketsOnly`;
