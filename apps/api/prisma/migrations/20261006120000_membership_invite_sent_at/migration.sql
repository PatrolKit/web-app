-- When this member was last emailed an invite to sign in, if ever. Shown on the
-- Members page so staff can see who has been told; sending again is allowed.

ALTER TABLE `Membership` ADD COLUMN `inviteSentAt` DATETIME(3) NULL;
