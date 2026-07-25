DROP INDEX "sites_primary_domain_unique";--> statement-breakpoint
DROP INDEX "users_email_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "sites_primary_domain_unique" ON "sites" USING btree (lower("primary_domain"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));