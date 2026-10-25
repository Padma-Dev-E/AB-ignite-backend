ALTER TABLE `quiz_attempts` ADD `pointsStatus` text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE `quiz_attempts` ADD `previousScorePercent` integer;--> statement-breakpoint
ALTER TABLE `quiz_challenge_participants` ADD `pointsStatus` text DEFAULT 'pending' NOT NULL;