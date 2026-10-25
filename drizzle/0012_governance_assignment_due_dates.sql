ALTER TABLE `ideas` ADD `assignedUserId` integer REFERENCES `users`(`id`) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `ideas` ADD `dueAt` integer;
--> statement-breakpoint
CREATE INDEX `ideas_assignment_due_idx` ON `ideas` (`assignedUserId`,`dueAt`);
