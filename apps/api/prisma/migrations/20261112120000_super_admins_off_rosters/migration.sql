-- iPad Plan 42: super admins leave Members and the clock-in roster.
--
-- No schema change. The roster now sends a super admin's row as a tombstone,
-- but an iPad only asks for rows whose membership moved since its last sync,
-- so their memberships are bumped once here to carry the tombstone out.
UPDATE `Membership` m
  JOIN `User` u ON u.`id` = m.`userId`
  SET m.`updatedAt` = CURRENT_TIMESTAMP(3)
  WHERE u.`isSuperAdmin` = true;
