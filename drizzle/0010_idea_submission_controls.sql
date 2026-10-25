CREATE TABLE `idea_reference_sequences` (
	`year` integer PRIMARY KEY NOT NULL,
	`lastValue` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `idea_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updatedBy` integer,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `idea_submissions` (
	`ideaId` integer PRIMARY KEY NOT NULL,
	`answersJson` text NOT NULL,
	`metricsJson` text NOT NULL,
	`score` real NOT NULL,
	`minimumScore` real NOT NULL,
	`validationPassed` integer DEFAULT false NOT NULL,
	`differentiation` text,
	`submittedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`ideaId`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE cascade
);
