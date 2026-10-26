UPDATE `ai_runs` SET `promptVersion` = '1'
WHERE `jobKey` IN ('idea.preflight', 'idea.validate', 'idea.enrich', 'idea.questions')
  AND `status` IN ('queued', 'running');
