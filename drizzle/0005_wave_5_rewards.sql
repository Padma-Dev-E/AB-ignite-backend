CREATE TABLE `badges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`ruleJson` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `badges_code_unique` ON `badges` (`code`);--> statement-breakpoint
CREATE INDEX `badges_active_idx` ON `badges` (`active`);--> statement-breakpoint
CREATE TABLE `levels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`minimumPoints` integer NOT NULL,
	`sortOrder` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `levels_minimum_points_unique` ON `levels` (`minimumPoints`);--> statement-breakpoint
CREATE UNIQUE INDEX `levels_sort_order_unique` ON `levels` (`sortOrder`);--> statement-breakpoint
CREATE TABLE `point_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`points` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `point_rules_code_unique` ON `point_rules` (`code`);--> statement-breakpoint
CREATE INDEX `point_rules_active_idx` ON `point_rules` (`active`);--> statement-breakpoint
CREATE TABLE `points_balances` (
	`userId` integer PRIMARY KEY NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`totalEarned` integer DEFAULT 0 NOT NULL,
	`totalSpent` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `points_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`amount` integer NOT NULL,
	`eventType` text NOT NULL,
	`sourceType` text NOT NULL,
	`sourceId` text,
	`idempotencyKey` text NOT NULL,
	`metadataJson` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `points_ledger_idempotency_unique` ON `points_ledger` (`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `points_ledger_user_created_idx` ON `points_ledger` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `points_ledger_source_idx` ON `points_ledger` (`sourceType`,`sourceId`);--> statement-breakpoint
CREATE TABLE `redemptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`rewardId` integer NOT NULL,
	`rewardVersionId` integer NOT NULL,
	`rewardName` text NOT NULL,
	`rewardDescription` text,
	`cost` integer NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`idempotencyKey` text NOT NULL,
	`requestedAt` integer NOT NULL,
	`fulfilledAt` integer,
	`cancelledAt` integer,
	`handledBy` integer,
	`cancellationReason` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rewardId`) REFERENCES `rewards`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`rewardVersionId`) REFERENCES `reward_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`handledBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `redemptions_idempotency_unique` ON `redemptions` (`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `redemptions_user_created_idx` ON `redemptions` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `redemptions_status_created_idx` ON `redemptions` (`status`,`createdAt`);--> statement-breakpoint
CREATE TABLE `reward_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`redemptionId` integer NOT NULL,
	`actorUserId` integer,
	`eventType` text NOT NULL,
	`fromStatus` text,
	`toStatus` text,
	`idempotencyKey` text NOT NULL,
	`metadataJson` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`redemptionId`) REFERENCES `redemptions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reward_events_idempotency_unique` ON `reward_events` (`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `reward_events_redemption_created_idx` ON `reward_events` (`redemptionId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `reward_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rewardId` integer NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`cost` integer NOT NULL,
	`emoji` text,
	`active` integer NOT NULL,
	`createdBy` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`rewardId`) REFERENCES `rewards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reward_versions_reward_version_unique` ON `reward_versions` (`rewardId`,`version`);--> statement-breakpoint
CREATE INDEX `reward_versions_reward_created_idx` ON `reward_versions` (`rewardId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `user_badges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`badgeId` integer NOT NULL,
	`awardedAt` integer NOT NULL,
	`metadataJson` text,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`badgeId`) REFERENCES `badges`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_badges_user_badge_unique` ON `user_badges` (`userId`,`badgeId`);--> statement-breakpoint
CREATE INDEX `user_badges_user_awarded_idx` ON `user_badges` (`userId`,`awardedAt`);--> statement-breakpoint
ALTER TABLE `rewards` ADD `active` integer DEFAULT true NOT NULL;
--> statement-breakpoint
INSERT INTO `point_rules` (`code`, `name`, `description`, `points`, `active`, `createdAt`, `updatedAt`) VALUES
  ('idea_submission', 'Idea submitted', 'Submitting an eligible idea', 50, 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('screening_passed', 'Screening passed', 'Passing the initial screening', 100, 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('idea_approval', 'Idea approved', 'An idea is approved for proof of concept', 300, 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('implementation', 'Idea implemented', 'An idea reaches implementation', 500, 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('validated_benefits', 'Benefits validated', 'Reported benefits are validated', 500, 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('idea_comment', 'Community comment', 'Commenting on a colleague idea', 5, 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('idea_support', 'Community support', 'Supporting a colleague idea', 2, 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('challenge_join', 'Challenge joined', 'Joining an innovation challenge', 20, 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('quiz_correct', 'Quiz answer', 'A correct first-attempt quiz answer', 10, 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('article_read', 'Article completed', 'Completing a recommended article', 10, 1, unixepoch('now') * 1000, unixepoch('now') * 1000);
--> statement-breakpoint
INSERT INTO `levels` (`name`, `description`, `minimumPoints`, `sortOrder`, `createdAt`, `updatedAt`) VALUES
  ('Ignite Starter', 'Begin your innovation journey', 0, 0, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('Idea Spark', 'Your ideas are gaining momentum', 500, 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('Innovation Explorer', 'You are actively exploring change', 1000, 2, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('Change Catalyst', 'You turn participation into progress', 2000, 3, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('Transformation Leader', 'You lead meaningful transformation', 3500, 4, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('Transformation Champion', 'You are a transformation champion', 5000, 5, unixepoch('now') * 1000, unixepoch('now') * 1000);
--> statement-breakpoint
INSERT INTO `badges` (`code`, `name`, `description`, `ruleJson`, `active`, `createdAt`, `updatedAt`) VALUES
  ('first-idea', 'First Idea', 'Submit your first idea', '{"eventType":"idea_submitted","minimumCount":1}', 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('poc-pioneer', 'POC Pioneer', 'Move an idea into proof of concept', '{"eventType":"idea_poc","minimumCount":1}', 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('impact-builder', 'Impact Builder', 'See an idea reach implementation', '{"eventType":"idea_implemented","minimumCount":1}', 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('value-creator', 'Value Creator', 'Deliver validated benefits', '{"eventType":"benefits_validated","minimumCount":1}', 1, unixepoch('now') * 1000, unixepoch('now') * 1000);
--> statement-breakpoint
INSERT INTO `reward_versions` (`rewardId`, `version`, `name`, `description`, `kind`, `cost`, `emoji`, `active`, `createdBy`, `createdAt`)
  SELECT `id`, 1, `name`, `description`, `kind`, `cost`, `emoji`, `active`, NULL, `createdAt` FROM `rewards`;
--> statement-breakpoint
INSERT INTO `points_ledger` (`userId`, `amount`, `eventType`, `sourceType`, `sourceId`, `idempotencyKey`, `metadataJson`, `createdAt`)
  SELECT `id`, `points`, 'legacy_migration', 'legacy_users_points', CAST(`id` AS TEXT), 'legacy-users-points:' || CAST(`id` AS TEXT), '{"migratedFrom":"users.points"}', `updatedAt`
  FROM `users` WHERE `points` <> 0;
--> statement-breakpoint
INSERT INTO `points_balances` (`userId`, `balance`, `totalEarned`, `totalSpent`, `updatedAt`)
  SELECT `users`.`id`, COALESCE(SUM(`points_ledger`.`amount`), 0),
    COALESCE(SUM(CASE WHEN `points_ledger`.`amount` > 0 THEN `points_ledger`.`amount` ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN `points_ledger`.`amount` < 0 THEN -`points_ledger`.`amount` ELSE 0 END), 0),
    `users`.`updatedAt`
  FROM `users` LEFT JOIN `points_ledger` ON `points_ledger`.`userId` = `users`.`id`
  GROUP BY `users`.`id`;
--> statement-breakpoint
CREATE TRIGGER `points_ledger_no_update`
BEFORE UPDATE ON `points_ledger`
BEGIN
  SELECT RAISE(ABORT, 'points_ledger is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `points_ledger_no_delete`
BEFORE DELETE ON `points_ledger`
BEGIN
  SELECT RAISE(ABORT, 'points_ledger is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `reward_versions_no_update`
BEFORE UPDATE ON `reward_versions`
BEGIN
  SELECT RAISE(ABORT, 'reward_versions are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `reward_versions_no_delete`
BEFORE DELETE ON `reward_versions`
BEGIN
  SELECT RAISE(ABORT, 'reward_versions are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `reward_events_no_update`
BEFORE UPDATE ON `reward_events`
BEGIN
  SELECT RAISE(ABORT, 'reward_events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `reward_events_no_delete`
BEFORE DELETE ON `reward_events`
BEGIN
  SELECT RAISE(ABORT, 'reward_events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `user_badges_no_update`
BEFORE UPDATE ON `user_badges`
BEGIN
  SELECT RAISE(ABORT, 'user_badges are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `user_badges_no_delete`
BEFORE DELETE ON `user_badges`
BEGIN
  SELECT RAISE(ABORT, 'user_badges are append-only');
END;
