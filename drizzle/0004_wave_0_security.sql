CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actorUserId` integer,
	`sessionId` integer,
	`action` text NOT NULL,
	`targetType` text,
	`targetId` text,
	`reason` text,
	`metadataJson` text,
	`ipHash` text,
	`userAgentHash` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sessionId`) REFERENCES `refresh_tokens`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_events_actor_idx` ON `audit_events` (`actorUserId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `audit_events_action_idx` ON `audit_events` (`action`,`createdAt`);--> statement-breakpoint
CREATE INDEX `audit_events_target_idx` ON `audit_events` (`targetType`,`targetId`,`createdAt`);--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `idleExpiresAt` integer;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `absoluteExpiresAt` integer;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `ipHash` text;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `userAgentHash` text;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `lastSeenAt` integer;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `sessionVersion` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `revocationReason` text;--> statement-breakpoint
ALTER TABLE `users` ADD `isActive` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `failedLoginAttempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `lockedUntil` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `lastFailedLoginAt` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `lastLoginAt` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `lastSeenAt` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `sessionVersion` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `deactivatedAt` integer;--> statement-breakpoint
CREATE TRIGGER `audit_events_no_update`
BEFORE UPDATE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `audit_events_no_delete`
BEFORE DELETE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;
