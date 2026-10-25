CREATE TABLE `refresh_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`tokenHash` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`revokedAt` integer,
	`rotatedFromId` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_hash_unique` ON `refresh_tokens` (`tokenHash`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_user_idx` ON `refresh_tokens` (`userId`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_expiry_idx` ON `refresh_tokens` (`expiresAt`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`department` text DEFAULT 'Other' NOT NULL,
	`jobTitle` text,
	`passwordHash` text NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	`rank` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "name", "email", "role", "department", "jobTitle", "passwordHash", "points", "rank", "createdAt", "updatedAt") SELECT "id", "name", "email", 'user', "department", "jobTitle", COALESCE("passwordHash", ''), "points", "rank", "createdAt", "updatedAt" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
