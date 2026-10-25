CREATE TABLE `badge_admin_operations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`keyHash` text NOT NULL,
	`actorUserId` integer NOT NULL,
	`badgeId` integer NOT NULL,
	`action` text NOT NULL,
	`requestHash` text NOT NULL,
	`responseJson` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`badgeId`) REFERENCES `badges`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `badge_admin_operations_key_unique` ON `badge_admin_operations` (`keyHash`);
