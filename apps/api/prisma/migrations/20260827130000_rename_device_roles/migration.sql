-- Device.role is a plain String column, so the schema diff that introduced the
-- new identifiers could not know the existing values needed rewriting. A row
-- left holding the old prose fails validation on every read.
--
-- Bulk Seller maps onto the check-in role rather than being deleted: it granted
-- exactly the same access, so relabelling a device someone deployed is honest,
-- and revoking one would not be.
UPDATE `Device` SET `role` = 'ski_swap.staff_check_in'  WHERE `role` = 'Ski Swap - Check-In';
UPDATE `Device` SET `role` = 'ski_swap.staff_check_in'  WHERE `role` = 'Ski Swap - Bulk Seller';
UPDATE `Device` SET `role` = 'ski_swap.print_bridge'    WHERE `role` = 'Ski Swap - Network Printer Adapter';
UPDATE `Device` SET `role` = 'time_clock.terminal'      WHERE `role` = 'Time Clock';
