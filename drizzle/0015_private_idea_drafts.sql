-- Drafts created by the earlier development flow had the public screening status.
-- Only generated provisional references with no completed submission are changed.
UPDATE `ideas`
SET `status` = 'draft'
WHERE `status` = 'screening'
  AND `reference` LIKE 'IDEA-%'
  AND NOT EXISTS (
    SELECT 1 FROM `idea_submissions` AS `submission`
    WHERE `submission`.`ideaId` = `ideas`.`id`
      AND `submission`.`submittedAt` IS NOT NULL
  );
