CREATE TABLE `idea_supports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ideaId` integer NOT NULL,
	`userId` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`ideaId`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idea_supports_idea_user_unique` ON `idea_supports` (`ideaId`,`userId`);
--> statement-breakpoint
CREATE INDEX `idea_supports_idea_idx` ON `idea_supports` (`ideaId`);
--> statement-breakpoint
CREATE INDEX `idea_supports_user_idx` ON `idea_supports` (`userId`);
