CREATE TABLE `ai_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ideaId` integer NOT NULL,
	`ideaVersionId` integer,
	`jobKey` text NOT NULL,
	`jobVersion` text NOT NULL,
	`promptVersion` text NOT NULL,
	`model` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`idempotencyKey` text NOT NULL,
	`correlationId` text NOT NULL,
	`requestedBy` integer,
	`inputHash` text NOT NULL,
	`attemptCount` integer DEFAULT 0 NOT NULL,
	`resultJson` text,
	`usageJson` text,
	`finishReason` text,
	`errorCode` text,
	`errorMessage` text,
	`workerId` text,
	`availableAt` integer NOT NULL,
	`startedAt` integer,
	`completedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`ideaId`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ideaVersionId`) REFERENCES `idea_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requestedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_runs_idempotency_unique` ON `ai_runs` (`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `ai_runs_idea_idx` ON `ai_runs` (`ideaId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ai_runs_status_available_idx` ON `ai_runs` (`status`,`availableAt`);--> statement-breakpoint
CREATE INDEX `ai_runs_correlation_idx` ON `ai_runs` (`correlationId`);--> statement-breakpoint
CREATE TABLE `idea_ai_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ideaId` integer NOT NULL,
	`ideaVersionId` integer,
	`runId` integer NOT NULL,
	`jobKey` text NOT NULL,
	`jobVersion` text NOT NULL,
	`resultJson` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`ideaId`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ideaVersionId`) REFERENCES `idea_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`runId`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idea_ai_results_run_unique` ON `idea_ai_results` (`runId`);--> statement-breakpoint
CREATE INDEX `idea_ai_results_idea_idx` ON `idea_ai_results` (`ideaId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `idea_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ideaId` integer NOT NULL,
	`ideaVersionId` integer,
	`actorType` text NOT NULL,
	`actorId` integer,
	`eventType` text NOT NULL,
	`fromStatus` text,
	`toStatus` text,
	`correlationId` text,
	`metadataJson` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`ideaId`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ideaVersionId`) REFERENCES `idea_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actorId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idea_events_idea_idx` ON `idea_events` (`ideaId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idea_events_correlation_idx` ON `idea_events` (`correlationId`);--> statement-breakpoint
CREATE TABLE `idea_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ideaId` integer NOT NULL,
	`reviewerId` integer,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`conflictAcknowledged` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`ideaId`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewerId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idea_reviews_idea_idx` ON `idea_reviews` (`ideaId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `idea_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ideaId` integer NOT NULL,
	`authorId` integer NOT NULL,
	`version` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`problem` text,
	`solution` text,
	`benefits` text,
	`risks` text,
	`category` text NOT NULL,
	`dataClassification` text DEFAULT 'internal' NOT NULL,
	`contentHash` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`ideaId`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`authorId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idea_versions_idea_version_unique` ON `idea_versions` (`ideaId`,`version`);--> statement-breakpoint
CREATE INDEX `idea_versions_idea_idx` ON `idea_versions` (`ideaId`,`createdAt`);