-- Binding indemnification lookup (Plan 44): programs, per-season entries on
-- binding model nodes, the "same details as" pointer, and the NSSRA declaration.

ALTER TABLE `SkiSwapSettings`
    ADD COLUMN `nssraMember` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `nssraMemberSetBy` VARCHAR(191) NULL,
    ADD COLUMN `nssraMemberSetAt` DATETIME(3) NULL;

ALTER TABLE `TaxonomyNode` ADD COLUMN `sameDetailsAsId` VARCHAR(191) NULL;
CREATE INDEX `TaxonomyNode_sameDetailsAsId_idx` ON `TaxonomyNode`(`sameDetailsAsId`);
ALTER TABLE `TaxonomyNode` ADD CONSTRAINT `TaxonomyNode_sameDetailsAsId_fkey`
    FOREIGN KEY (`sameDetailsAsId`) REFERENCES `TaxonomyNode`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `BindingIndemnificationProgram` (
    `key` VARCHAR(40) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `notes` TEXT NOT NULL,
    `latestSeason` VARCHAR(7) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `BindingIndemnificationImport` (
    `id` VARCHAR(191) NOT NULL,
    `season` VARCHAR(7) NOT NULL,
    `fileName` VARCHAR(191) NULL,
    `counts` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdById` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `BindingIndemnification` (
    `id` VARCHAR(191) NOT NULL,
    `nodeId` VARCHAR(191) NOT NULL,
    `programKey` VARCHAR(40) NOT NULL,
    `season` VARCHAR(7) NOT NULL,
    `status` ENUM('LISTED', 'FINAL_SEASON') NOT NULL DEFAULT 'LISTED',
    `retail` BOOLEAN NOT NULL DEFAULT false,
    `rental` BOOLEAN NOT NULL DEFAULT false,
    `demo` BOOLEAN NOT NULL DEFAULT false,
    `currentLine` BOOLEAN NULL,
    `nonIso` BOOLEAN NOT NULL DEFAULT false,
    `source` ENUM('NSSRA', 'MANUFACTURER') NOT NULL,
    `sourceRef` VARCHAR(191) NULL,
    `note` VARCHAR(500) NULL,
    `importId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BindingIndemnification_nodeId_season_key`(`nodeId`, `season`),
    INDEX `BindingIndemnification_programKey_season_idx`(`programKey`, `season`),
    INDEX `BindingIndemnification_importId_idx`(`importId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `BindingIndemnification` ADD CONSTRAINT `BindingIndemnification_nodeId_fkey`
    FOREIGN KEY (`nodeId`) REFERENCES `TaxonomyNode`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `BindingIndemnification` ADD CONSTRAINT `BindingIndemnification_programKey_fkey`
    FOREIGN KEY (`programKey`) REFERENCES `BindingIndemnificationProgram`(`key`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `BindingIndemnification` ADD CONSTRAINT `BindingIndemnification_importId_fkey`
    FOREIGN KEY (`importId`) REFERENCES `BindingIndemnificationImport`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- The eight programs, with empty notes to be written in Platform Admin.
INSERT INTO `BindingIndemnificationProgram` (`key`, `name`, `notes`, `latestSeason`, `updatedAt`) VALUES
    ('amer', 'Amer Sports (Armada, Atomic, Salomon)', '', NULL, CURRENT_TIMESTAMP(3)),
    ('elan', 'Elan', '', NULL, CURRENT_TIMESTAMP(3)),
    ('elevate', 'Elevate Outdoor Collective (Marker)', '', NULL, CURRENT_TIMESTAMP(3)),
    ('fischer', 'Fischer', '', NULL, CURRENT_TIMESTAMP(3)),
    ('head_tyrolia', 'Head / Tyrolia', '', NULL, CURRENT_TIMESTAMP(3)),
    ('kneebinding', 'KneeBinding', '', NULL, CURRENT_TIMESTAMP(3)),
    ('rossignol', 'Rossignol Group (Look, Rossignol)', '', NULL, CURRENT_TIMESTAMP(3)),
    ('vtec', 'V-Tec', '', NULL, CURRENT_TIMESTAMP(3));

-- Skis › Bindings included › Yes and Snowboard › Bindings included › Yes take
-- their details from Bindings › Type › Skis and › Snowboard (Plan 44 D14).
-- Found by label path, so production's tree needs no seed re-run.
UPDATE `TaxonomyNode` yes
JOIN `TaxonomyNode` included ON included.`id` = yes.`parentId`
    AND included.`kind` = 'ATTRIBUTE' AND included.`orgId` IS NULL
    AND LOWER(included.`label`) = 'bindings included'
JOIN `TaxonomyNode` cat ON cat.`id` = included.`parentId`
    AND cat.`kind` = 'CATEGORY' AND cat.`orgId` IS NULL
JOIN `TaxonomyNode` bindings ON bindings.`kind` = 'CATEGORY' AND bindings.`orgId` IS NULL
    AND bindings.`parentId` IS NULL AND bindings.`label` = 'Bindings'
JOIN `TaxonomyNode` type ON type.`parentId` = bindings.`id`
    AND type.`kind` = 'ATTRIBUTE' AND type.`orgId` IS NULL AND type.`label` = 'Type'
JOIN `TaxonomyNode` target ON target.`parentId` = type.`id`
    AND target.`kind` = 'VALUE' AND target.`orgId` IS NULL
    AND target.`label` = CASE cat.`label` WHEN 'Skis' THEN 'Skis' WHEN 'Snowboard' THEN 'Snowboard' END
SET yes.`sameDetailsAsId` = target.`id`
WHERE yes.`kind` = 'VALUE' AND yes.`orgId` IS NULL AND yes.`label` = 'Yes'
    AND cat.`label` IN ('Skis', 'Snowboard');
