CREATE TABLE `ai_debug_exchanges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`runId` integer NOT NULL,
	`attempt` integer NOT NULL,
	`requestPayloadEncrypted` text NOT NULL,
	`responsePayloadEncrypted` text,
	`responseStatus` integer,
	`responseStatusText` text,
	`responseTruncated` integer DEFAULT false NOT NULL,
	`durationMs` integer DEFAULT 0 NOT NULL,
	`processingStage` text DEFAULT 'http_response' NOT NULL,
	`errorCode` text,
	`errorMessage` text,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	FOREIGN KEY (`runId`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_debug_exchanges_run_attempt_unique` ON `ai_debug_exchanges` (`runId`,`attempt`);
--> statement-breakpoint
CREATE INDEX `ai_debug_exchanges_expiry_idx` ON `ai_debug_exchanges` (`expiresAt`);
