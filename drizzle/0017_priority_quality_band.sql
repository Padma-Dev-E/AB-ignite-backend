-- Rename the persisted band in place. No idea rows or settings are removed.
UPDATE `ideas` SET `priorityBand` = 'Quality' WHERE `priorityBand` = 'Qualify';
--> statement-breakpoint

UPDATE `idea_settings`
SET `value` = replace(`value`, '"Qualify"', '"Quality"')
WHERE `key` = 'priority_bands'
  AND instr(`value`, '"Qualify"') > 0;
