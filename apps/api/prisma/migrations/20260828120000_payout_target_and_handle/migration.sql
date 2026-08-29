-- Payout destinations gain a recipient type and a typed value.
--
-- `payoutChannel` could only say "one of this person's verified contacts",
-- which cannot express a PayPal or Venmo account held under something else.

ALTER TABLE `User` ADD COLUMN `payoutTarget` VARCHAR(16) NULL;
ALTER TABLE `User` ADD COLUMN `payoutHandle` VARCHAR(191) NULL;

-- Carry the old values across: the same destinations, more precisely named.
-- A channel naming a contact that was never verified becomes null — that row
-- was not payable, and the new columns should not claim otherwise.
UPDATE `User`
   SET `payoutTarget` = CASE
         WHEN `payoutChannel` = 'email' AND `emailVerifiedAt` IS NOT NULL THEN 'EMAIL'
         WHEN `payoutChannel` = 'phone' AND `phoneVerifiedAt` IS NOT NULL THEN 'PHONE'
         ELSE NULL
       END
 WHERE `payoutChannel` IS NOT NULL;

ALTER TABLE `User` DROP COLUMN `payoutChannel`;
