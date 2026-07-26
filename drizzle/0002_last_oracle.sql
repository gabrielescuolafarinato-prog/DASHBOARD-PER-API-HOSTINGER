CREATE TYPE "public"."build_state" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "site_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"build_uuid" uuid NOT NULL,
	"state" "build_state" NOT NULL,
	"origin" text,
	"hostinger_created_at" timestamp with time zone,
	"hostinger_updated_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_builds" ADD CONSTRAINT "site_builds_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_builds_build_uuid_unique" ON "site_builds" USING btree ("build_uuid");--> statement-breakpoint
CREATE INDEX "site_builds_site_state_idx" ON "site_builds" USING btree ("site_id","state");--> statement-breakpoint
CREATE INDEX "site_builds_site_updated_idx" ON "site_builds" USING btree ("site_id","hostinger_updated_at");