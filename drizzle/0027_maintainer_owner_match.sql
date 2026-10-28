UPDATE `refresh_tokens`
SET `revokedAt` = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    `revocationReason` = COALESCE(`revocationReason`, 'role_model_changed')
WHERE `revokedAt` IS NULL
  AND `userId` IN (SELECT `id` FROM `users` WHERE `role` = 'back_office');
--> statement-breakpoint
UPDATE `users`
SET `role` = 'admin',
    `sessionVersion` = `sessionVersion` + 1
WHERE `role` = 'back_office';
--> statement-breakpoint
ALTER TABLE `users` ADD `businessProfile` text;
--> statement-breakpoint
UPDATE `idea_settings`
SET `value` = (
  SELECT json_group_array(`mapped_role`)
  FROM (
    SELECT `mapped_role` FROM (
      SELECT DISTINCT CASE `value`
        WHEN 'back_office' THEN 'admin'
        ELSE `value`
      END AS `mapped_role`
      FROM json_each(`idea_settings`.`value`)
      WHERE `type` = 'text'
        AND `value` IN ('employee', 'back_office', 'admin', 'maintainer', 'business_owner')
      UNION
      SELECT 'maintainer'
    )
    ORDER BY `mapped_role`
  )
)
WHERE `key` = 'roles'
  AND json_valid(`value`);
