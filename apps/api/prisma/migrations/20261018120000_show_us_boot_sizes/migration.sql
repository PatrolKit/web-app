-- Whether a ski boot's name adds its US size beside its Mondopoint.
ALTER TABLE `SkiSwapSettings` ADD COLUMN `showUsBootSizes` BOOLEAN NOT NULL DEFAULT false;
