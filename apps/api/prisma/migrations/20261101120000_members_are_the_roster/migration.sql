-- Plan 57: the roster is the members. Additive.
--
-- A member chooses a PIN to clock in with when they have no NSP ID (D7).

-- AlterTable
ALTER TABLE `PatrollerProfile` ADD COLUMN `clockPin` VARCHAR(6) NULL;

-- Every member gets a member record (D2): each live membership that is a
-- member by the rule this replaces (no live seller profile, or any
-- permission) and has none. Inserts only; nothing existing is changed.
INSERT INTO `PatrollerProfile` (`id`, `membershipId`, `active`, `createdAt`, `updatedAt`)
SELECT CONCAT('mr', SUBSTRING(MD5(m.`id`), 1, 23)), m.`id`, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Membership` m
LEFT JOIN `PatrollerProfile` pp ON pp.`membershipId` = m.`id`
LEFT JOIN `SellerProfile` sp ON sp.`membershipId` = m.`id`
WHERE pp.`id` IS NULL
  AND m.`deletedAt` IS NULL
  AND (
    sp.`id` IS NULL
    OR sp.`deletedAt` IS NOT NULL
    OR EXISTS (SELECT 1 FROM `MembershipPermission` mp WHERE mp.`membershipId` = m.`id`)
  );
