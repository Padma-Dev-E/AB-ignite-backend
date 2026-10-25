CREATE TABLE `notification_email_deliveries` (
	`notificationId` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claimToken` text,
	`claimedUntil` integer,
	`nextAttemptAt` integer,
	`sentAt` integer,
	`lastErrorCode` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`notificationId`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_email_delivery_retry_idx` ON `notification_email_deliveries` (`status`,`nextAttemptAt`);
