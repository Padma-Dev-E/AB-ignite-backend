CREATE TABLE `idea_draft_progress` (
	`ideaId` integer PRIMARY KEY NOT NULL,
	`progressJson` text NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`ideaId`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE cascade
);
