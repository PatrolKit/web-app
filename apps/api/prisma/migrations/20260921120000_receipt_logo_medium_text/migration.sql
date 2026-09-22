-- `Organization.logoUrl` was widened to MediumText so an org with no S3 could
-- keep its mark as a data URI. `Receipt.orgLogoUrl` copies that value and was
-- left at VARCHAR(191), so snapshotting a receipt for such an org failed on
-- "value too long" — silently, because the snapshot is best-effort.

ALTER TABLE `Receipt` MODIFY COLUMN `orgLogoUrl` MEDIUMTEXT NULL;
