DROP TABLE `reward_events`;--> statement-breakpoint
DROP TABLE `redemptions`;--> statement-breakpoint
DROP TABLE `user_rewards`;--> statement-breakpoint
ALTER TABLE `points_balances` DROP COLUMN `totalSpent`;--> statement-breakpoint
UPDATE `rewards` SET `kind` = 'catalogue' WHERE `kind` = 'redeem';--> statement-breakpoint
UPDATE `reward_versions` SET `kind` = 'catalogue' WHERE `kind` = 'redeem';
