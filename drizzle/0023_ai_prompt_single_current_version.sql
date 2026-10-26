DROP TRIGGER IF EXISTS `ai_prompt_versions_no_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `ai_prompt_versions_no_delete`;
--> statement-breakpoint
DELETE FROM `ai_prompt_versions`
WHERE `jobKey` NOT IN ('idea.preflight', 'idea.validate', 'idea.enrich', 'idea.questions');
--> statement-breakpoint
DELETE FROM `ai_prompt_catalog`
WHERE `jobKey` NOT IN ('idea.preflight', 'idea.validate', 'idea.enrich', 'idea.questions');
--> statement-breakpoint
DELETE FROM `ai_prompt_versions`
WHERE `jobKey` IN ('idea.preflight', 'idea.validate', 'idea.enrich', 'idea.questions')
  AND `version` <> (
    SELECT `activeVersion` FROM `ai_prompt_catalog`
    WHERE `ai_prompt_catalog`.`jobKey` = `ai_prompt_versions`.`jobKey`
  );
--> statement-breakpoint
UPDATE `ai_prompt_versions` SET `version` = 1
WHERE `jobKey` IN ('idea.preflight', 'idea.validate', 'idea.enrich', 'idea.questions');
--> statement-breakpoint
UPDATE `ai_prompt_catalog` SET `activeVersion` = 1, `updatedAt` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `jobKey` IN ('idea.preflight', 'idea.validate', 'idea.enrich', 'idea.questions');
--> statement-breakpoint
CREATE TRIGGER `ai_prompt_versions_no_update`
BEFORE UPDATE ON `ai_prompt_versions`
BEGIN
	SELECT RAISE(ABORT, 'ai_prompt_versions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `ai_prompt_versions_no_delete`
BEFORE DELETE ON `ai_prompt_versions`
BEGIN
	SELECT RAISE(ABORT, 'ai_prompt_versions are append-only');
END;
