-- The three devices:* permissions retire with the page they gated. Hardware is
-- authorised by the module its role names instead, so leaving these rows behind
-- means a permission that grants nothing can still be assigned to someone.
--
-- MembershipPermission cascades on the Permission delete, so any existing grants
-- go with them.
DELETE FROM `Permission` WHERE `key` IN ('devices:read', 'devices:provision', 'devices:revoke');
