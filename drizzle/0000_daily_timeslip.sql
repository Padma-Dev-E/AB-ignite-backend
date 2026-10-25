CREATE TABLE `articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`body` text NOT NULL,
	`category` text NOT NULL,
	`topic` text,
	`publisher` text NOT NULL,
	`difficulty` text NOT NULL,
	`readingMinutes` integer NOT NULL,
	`publishedLabel` text,
	`url` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `articles_category_idx` ON `articles` (`category`);--> statement-breakpoint
CREATE TABLE `idea_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ideaId` integer NOT NULL,
	`authorId` integer NOT NULL,
	`body` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`ideaId`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`authorId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idea_comments_idea_idx` ON `idea_comments` (`ideaId`);--> statement-breakpoint
CREATE TABLE `ideas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`authorId` integer NOT NULL,
	`kind` text DEFAULT 'idea' NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`problem` text,
	`solution` text,
	`benefits` text,
	`risks` text,
	`category` text NOT NULL,
	`status` text DEFAULT 'screening' NOT NULL,
	`priorityBand` text,
	`priorityScore` real,
	`reference` text NOT NULL,
	`challengeId` integer,
	`buildsOnId` integer,
	`supports` integer DEFAULT 0 NOT NULL,
	`comments` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`authorId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ideas_reference_unique` ON `ideas` (`reference`);--> statement-breakpoint
CREATE INDEX `ideas_author_idx` ON `ideas` (`authorId`);--> statement-breakpoint
CREATE INDEX `ideas_status_idx` ON `ideas` (`status`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`isRead` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`userId`,`isRead`);--> statement-breakpoint
CREATE TABLE `quizzes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`difficulty` text NOT NULL,
	`objective` text NOT NULL,
	`passMark` integer NOT NULL,
	`pointsPerQuestion` integer NOT NULL,
	`questionCount` integer NOT NULL,
	`timeLimitSeconds` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quizzes_category_idx` ON `quizzes` (`category`);--> statement-breakpoint
CREATE TABLE `rewards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`cost` integer NOT NULL,
	`emoji` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_rewards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`rewardId` integer NOT NULL,
	`status` text DEFAULT 'earned' NOT NULL,
	`redeemedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rewardId`) REFERENCES `rewards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_rewards_user_reward_unique` ON `user_rewards` (`userId`,`rewardId`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`department` text DEFAULT 'Other' NOT NULL,
	`jobTitle` text,
	`passwordHash` text,
	`points` integer DEFAULT 0 NOT NULL,
	`rank` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);