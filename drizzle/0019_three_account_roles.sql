UPDATE `users`
SET `role` = CASE
  WHEN `role` = 'admin' OR `profile` IN ('admin', 'reviewer', 'control', 'management') THEN 'back_office'
  WHEN `profile` = 'business_owner' THEN 'business_owner'
  ELSE 'employee'
END;
--> statement-breakpoint
UPDATE `refresh_tokens`
SET `revokedAt` = COALESCE(`revokedAt`, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    `revocationReason` = COALESCE(`revocationReason`, 'role_model_changed')
WHERE `revokedAt` IS NULL;
--> statement-breakpoint
UPDATE `idea_settings`
SET `key` = 'roles',
    `value` = CASE
      WHEN json_valid(`value`) THEN COALESCE((
        SELECT json_group_array(mapped_role)
        FROM (
          SELECT DISTINCT CASE `value`
            WHEN 'employee' THEN 'employee'
            WHEN 'business_owner' THEN 'business_owner'
            WHEN 'reviewer' THEN 'back_office'
            WHEN 'control' THEN 'back_office'
            WHEN 'management' THEN 'back_office'
            WHEN 'admin' THEN 'back_office'
          END AS mapped_role
          FROM json_each(`idea_settings`.`value`)
          WHERE `type` = 'text' AND `value` IN ('employee', 'business_owner', 'reviewer', 'control', 'management', 'admin')
          ORDER BY mapped_role
        )
      ), '[]')
      ELSE '[]'
    END
WHERE `key` = 'profiles';
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'employee' NOT NULL,
	`department` text DEFAULT 'Other' NOT NULL,
	`jobTitle` text,
	`passwordHash` text NOT NULL,
	`mustChangePassword` integer DEFAULT false NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`failedLoginAttempts` integer DEFAULT 0 NOT NULL,
	`lockedUntil` integer,
	`lastFailedLoginAt` integer,
	`lastLoginAt` integer,
	`lastSeenAt` integer,
	`sessionVersion` integer DEFAULT 0 NOT NULL,
	`deactivatedAt` integer,
	`points` integer DEFAULT 0 NOT NULL,
	`rank` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "name", "email", "role", "department", "jobTitle", "passwordHash", "mustChangePassword", "isActive", "failedLoginAttempts", "lockedUntil", "lastFailedLoginAt", "lastLoginAt", "lastSeenAt", "sessionVersion", "deactivatedAt", "points", "rank", "createdAt", "updatedAt") SELECT "id", "name", "email", "role", "department", "jobTitle", "passwordHash", "mustChangePassword", "isActive", "failedLoginAttempts", "lockedUntil", "lastFailedLoginAt", "lastLoginAt", "lastSeenAt", "sessionVersion", "deactivatedAt", "points", "rank", "createdAt", "updatedAt" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
