CREATE TABLE "site_databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key_hash" text NOT NULL,
	"database_user" text NOT NULL,
	"verified_domain" text NOT NULL,
	"disk_usage_mb" integer,
	"max_size_mb" integer,
	"hostinger_created_at" timestamp with time zone,
	"hostinger_updated_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_databases_name_length_check" CHECK (char_length("site_databases"."name") BETWEEN 1 AND 128),
	CONSTRAINT "site_databases_name_key_hash_check" CHECK ("site_databases"."name_key_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "site_databases_user_length_check" CHECK (char_length("site_databases"."database_user") BETWEEN 1 AND 128),
	CONSTRAINT "site_databases_domain_length_check" CHECK (char_length("site_databases"."verified_domain") BETWEEN 1 AND 253),
	CONSTRAINT "site_databases_disk_usage_nonnegative_check" CHECK ("site_databases"."disk_usage_mb" IS NULL OR "site_databases"."disk_usage_mb" >= 0),
	CONSTRAINT "site_databases_max_size_nonnegative_check" CHECK ("site_databases"."max_size_mb" IS NULL OR "site_databases"."max_size_mb" >= 0)
);
--> statement-breakpoint
ALTER TABLE "hostinger_operations" ADD COLUMN "resource_key_hash" text;--> statement-breakpoint
ALTER TABLE "site_databases" ADD CONSTRAINT "site_databases_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_databases_name_key_unique" ON "site_databases" USING btree ("name_key_hash");--> statement-breakpoint
CREATE INDEX "site_databases_site_verified_idx" ON "site_databases" USING btree ("site_id","last_verified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hostinger_operations_active_unscoped_unique" ON "hostinger_operations" USING btree ("site_id","operation_type") WHERE "hostinger_operations"."status" = 'IN_PROGRESS' AND "hostinger_operations"."resource_key_hash" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hostinger_operations_active_resource_unique" ON "hostinger_operations" USING btree ("site_id","resource_key_hash") WHERE "hostinger_operations"."status" = 'IN_PROGRESS' AND "hostinger_operations"."resource_key_hash" IS NOT NULL;--> statement-breakpoint
DROP INDEX "hostinger_operations_active_site_type_unique";
