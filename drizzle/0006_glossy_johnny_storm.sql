CREATE TABLE `quiz_attempt_answers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attemptId` integer NOT NULL,
	`questionId` integer NOT NULL,
	`optionKey` text NOT NULL,
	`answeredAt` integer NOT NULL,
	FOREIGN KEY (`attemptId`) REFERENCES `quiz_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`questionId`) REFERENCES `quiz_questions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_attempt_answers_attempt_question_unique` ON `quiz_attempt_answers` (`attemptId`,`questionId`);--> statement-breakpoint
CREATE INDEX `quiz_attempt_answers_attempt_idx` ON `quiz_attempt_answers` (`attemptId`);--> statement-breakpoint
CREATE TABLE `quiz_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`quizId` integer NOT NULL,
	`quizVersionId` integer NOT NULL,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`startedAt` integer NOT NULL,
	`expiresAt` integer,
	`submittedAt` integer,
	`scorePercent` integer,
	`correctCount` integer,
	`totalQuestions` integer NOT NULL,
	`passed` integer,
	`pointsAwarded` integer DEFAULT 0 NOT NULL,
	`firstAttempt` integer DEFAULT false NOT NULL,
	`idempotencyKey` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`quizId`) REFERENCES `quizzes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`quizVersionId`) REFERENCES `quiz_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_attempts_idempotency_unique` ON `quiz_attempts` (`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `quiz_attempts_user_quiz_idx` ON `quiz_attempts` (`userId`,`quizId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `quiz_attempts_status_expiry_idx` ON `quiz_attempts` (`status`,`expiresAt`);--> statement-breakpoint
CREATE TABLE `quiz_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`sortOrder` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_categories_code_unique` ON `quiz_categories` (`code`);--> statement-breakpoint
CREATE INDEX `quiz_categories_active_idx` ON `quiz_categories` (`active`,`sortOrder`);--> statement-breakpoint
CREATE TABLE `quiz_challenge_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`challengeId` integer NOT NULL,
	`userId` integer NOT NULL,
	`idempotencyKey` text NOT NULL,
	`pointsAwarded` integer DEFAULT 0 NOT NULL,
	`joinedAt` integer NOT NULL,
	FOREIGN KEY (`challengeId`) REFERENCES `quiz_challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_challenge_participants_unique` ON `quiz_challenge_participants` (`challengeId`,`userId`);--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_challenge_participants_idempotency_unique` ON `quiz_challenge_participants` (`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `quiz_challenge_participants_challenge_idx` ON `quiz_challenge_participants` (`challengeId`,`joinedAt`);--> statement-breakpoint
CREATE TABLE `quiz_challenges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`question` text NOT NULL,
	`deadlineAt` integer NOT NULL,
	`points` integer DEFAULT 20 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quiz_challenges_open_idx` ON `quiz_challenges` (`active`,`deadlineAt`);--> statement-breakpoint
CREATE TABLE `quiz_options` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`questionId` integer NOT NULL,
	`optionKey` text NOT NULL,
	`label` text NOT NULL,
	`sortOrder` integer NOT NULL,
	`isCorrect` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`questionId`) REFERENCES `quiz_questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_options_question_key_unique` ON `quiz_options` (`questionId`,`optionKey`);--> statement-breakpoint
CREATE INDEX `quiz_options_question_order_idx` ON `quiz_options` (`questionId`,`sortOrder`);--> statement-breakpoint
CREATE TABLE `quiz_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quizVersionId` integer NOT NULL,
	`topic` text NOT NULL,
	`prompt` text NOT NULL,
	`sortOrder` integer NOT NULL,
	`points` integer DEFAULT 1 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`quizVersionId`) REFERENCES `quiz_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_questions_version_order_unique` ON `quiz_questions` (`quizVersionId`,`sortOrder`);--> statement-breakpoint
CREATE INDEX `quiz_questions_version_topic_idx` ON `quiz_questions` (`quizVersionId`,`topic`);--> statement-breakpoint
CREATE TABLE `quiz_recommendation_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic` text NOT NULL,
	`thresholdPercent` integer DEFAULT 70 NOT NULL,
	`reasonTemplate` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_recommendation_rules_topic_unique` ON `quiz_recommendation_rules` (`topic`);--> statement-breakpoint
CREATE INDEX `quiz_recommendation_rules_active_idx` ON `quiz_recommendation_rules` (`active`);--> statement-breakpoint
CREATE TABLE `quiz_recommendations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`topic` text NOT NULL,
	`categoryCode` text NOT NULL,
	`scorePercent` integer NOT NULL,
	`thresholdPercent` integer NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`sourceAttemptId` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sourceAttemptId`) REFERENCES `quiz_attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_recommendations_user_topic_open_unique` ON `quiz_recommendations` (`userId`,`topic`,`status`);--> statement-breakpoint
CREATE INDEX `quiz_recommendations_user_status_idx` ON `quiz_recommendations` (`userId`,`status`,`createdAt`);--> statement-breakpoint
CREATE TABLE `quiz_topic_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attemptId` integer NOT NULL,
	`userId` integer NOT NULL,
	`categoryCode` text NOT NULL,
	`topic` text NOT NULL,
	`correctCount` integer NOT NULL,
	`totalQuestions` integer NOT NULL,
	`scorePercent` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`attemptId`) REFERENCES `quiz_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_topic_results_attempt_topic_unique` ON `quiz_topic_results` (`attemptId`,`topic`);--> statement-breakpoint
CREATE INDEX `quiz_topic_results_user_topic_idx` ON `quiz_topic_results` (`userId`,`topic`,`createdAt`);--> statement-breakpoint
CREATE TABLE `quiz_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quizId` integer NOT NULL,
	`version` integer NOT NULL,
	`categoryCode` text NOT NULL,
	`level` text NOT NULL,
	`objective` text NOT NULL,
	`passMark` integer NOT NULL,
	`pointsPerQuestion` integer NOT NULL,
	`timeLimitSeconds` integer,
	`published` integer DEFAULT false NOT NULL,
	`publishedAt` integer,
	`createdBy` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`quizId`) REFERENCES `quizzes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_versions_quiz_version_unique` ON `quiz_versions` (`quizId`,`version`);--> statement-breakpoint
CREATE INDEX `quiz_versions_catalogue_idx` ON `quiz_versions` (`categoryCode`,`level`,`published`);