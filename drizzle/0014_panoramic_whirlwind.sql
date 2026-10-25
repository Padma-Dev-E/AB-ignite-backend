CREATE TABLE `ai_run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`runId` integer NOT NULL,
	`ideaId` integer NOT NULL,
	`ideaVersionId` integer,
	`eventType` text NOT NULL,
	`payloadJson` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`runId`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ideaId`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ideaVersionId`) REFERENCES `idea_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_run_events_run_created_idx` ON `ai_run_events` (`runId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `ai_run_events_idea_created_idx` ON `ai_run_events` (`ideaId`,`createdAt`,`id`);