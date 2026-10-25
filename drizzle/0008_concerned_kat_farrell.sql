CREATE TABLE `article_completions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`articleId` integer NOT NULL,
	`recommendationId` integer,
	`idempotencyKey` text NOT NULL,
	`pointsAwarded` integer DEFAULT 0 NOT NULL,
	`completedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`articleId`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recommendationId`) REFERENCES `quiz_recommendations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `article_completions_user_article_unique` ON `article_completions` (`userId`,`articleId`);--> statement-breakpoint
CREATE UNIQUE INDEX `article_completions_idempotency_unique` ON `article_completions` (`userId`,`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `article_completions_user_idx` ON `article_completions` (`userId`,`completedAt`);--> statement-breakpoint
CREATE TABLE `feedback_campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`startsAt` integer,
	`endsAt` integer,
	`createdBy` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `feedback_campaigns_active_idx` ON `feedback_campaigns` (`active`,`pinned`);--> statement-breakpoint
CREATE TABLE `feedback_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaignId` integer NOT NULL,
	`userId` integer NOT NULL,
	`category` text NOT NULL,
	`message` text NOT NULL,
	`idempotencyKey` text NOT NULL,
	`respondedBy` integer,
	`response` text,
	`respondedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`campaignId`) REFERENCES `feedback_campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`respondedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_responses_user_key_unique` ON `feedback_responses` (`userId`,`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `feedback_responses_campaign_idx` ON `feedback_responses` (`campaignId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `feedback_responses_user_idx` ON `feedback_responses` (`userId`,`createdAt`);--> statement-breakpoint
ALTER TABLE `articles` ADD `published` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `articles` ADD `contentType` text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE `articles` ADD `categoryCode` text DEFAULT 'general' NOT NULL;