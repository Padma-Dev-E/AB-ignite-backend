CREATE TABLE `ai_prompt_catalog` (
	`jobKey` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`activeVersion` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_prompt_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobKey` text NOT NULL,
	`version` integer NOT NULL,
	`systemPrompt` text NOT NULL,
	`contentHash` text NOT NULL,
	`createdBy` integer,
	`reason` text,
	`isDefault` integer DEFAULT false NOT NULL,
	`schemaVersion` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`jobKey`) REFERENCES `ai_prompt_catalog`(`jobKey`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_prompt_versions_key_version_unique` ON `ai_prompt_versions` (`jobKey`,`version`);
--> statement-breakpoint
CREATE INDEX `ai_prompt_versions_hash_idx` ON `ai_prompt_versions` (`contentHash`);
--> statement-breakpoint
ALTER TABLE `ai_runs` ADD `inputJson` text;
--> statement-breakpoint
CREATE TRIGGER `ai_prompt_versions_no_update`
BEFORE UPDATE ON `ai_prompt_versions`
BEGIN
	SELECT RAISE(ABORT, 'ai_prompt_versions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `ai_prompt_versions_no_delete`
BEFORE DELETE ON `ai_prompt_versions`
BEGIN
	SELECT RAISE(ABORT, 'ai_prompt_versions are append-only');
END;
