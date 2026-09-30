-- Plan 27: one print bridge may serve several staffed stations.
--
-- The unique index on `bridgeDeviceId` goes. MySQL refuses to drop an index a
-- foreign key depends on until another index covers the column, so the plain
-- one is created first. No data changes.

CREATE INDEX `CheckinStation_bridgeDeviceId_idx` ON `CheckinStation`(`bridgeDeviceId`);
DROP INDEX `CheckinStation_bridgeDeviceId_key` ON `CheckinStation`;
