-- Plan 31: the web's own "legacy tickets only", apart from staff check-in's.
-- Every swap starts off: the web behaves as before until someone turns it on.

ALTER TABLE `SkiSwap` ADD COLUMN `webLegacyTicketsOnly` BOOLEAN NOT NULL DEFAULT false;
