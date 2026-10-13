-- Plan 51: binding indemnification allowed per org by the platform, and on or
-- off per org for the web and the check-in iPads. Additive.
ALTER TABLE `Organization`
    ADD COLUMN `indemnificationAllowed` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `indemnificationAllowedBy` VARCHAR(191) NULL,
    ADD COLUMN `indemnificationAllowedAt` DATETIME(3) NULL;

ALTER TABLE `SkiSwapSettings`
    ADD COLUMN `indemnificationWeb` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `indemnificationIpad` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `indemnificationCertifiedBy` VARCHAR(191) NULL,
    ADD COLUMN `indemnificationCertifiedAt` DATETIME(3) NULL;

-- An org that declared NSSRA membership carries over: allowed, web and iPad
-- on, its declaration standing as the certification.
UPDATE `Organization` o
    JOIN `SkiSwapSettings` s ON s.`orgId` = o.`id`
    SET o.`indemnificationAllowed` = true,
        o.`indemnificationAllowedAt` = CURRENT_TIMESTAMP(3)
    WHERE s.`nssraMember` = true;

UPDATE `SkiSwapSettings`
    SET `indemnificationWeb` = true,
        `indemnificationIpad` = true,
        `indemnificationCertifiedBy` = `nssraMemberSetBy`,
        `indemnificationCertifiedAt` = `nssraMemberSetAt`
    WHERE `nssraMember` = true;
