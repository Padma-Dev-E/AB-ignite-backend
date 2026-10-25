ALTER TABLE `idea_submissions` ADD `aiValidationScore` real;--> statement-breakpoint
ALTER TABLE `idea_submissions` ADD `aiValidationAttempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `idea_submissions` ADD `submittedWithLowAiScore` integer DEFAULT false NOT NULL;