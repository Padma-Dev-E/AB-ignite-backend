ALTER TABLE `users` ADD `profile` text DEFAULT 'employee' NOT NULL;
--> statement-breakpoint
UPDATE `users` SET `profile` = 'admin' WHERE `role` = 'admin';
